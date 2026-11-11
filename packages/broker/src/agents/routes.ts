import type { OwnerFinancialTerms } from "../spend/owner-approval-terms.js";
// Plan 3 Task 7: the app's routes to build, version, publish, share and update agents (`/v1/app/agents*`). Every body is strict and
// carries a `requestId` (R18). Each route checks access first, with `requireAgentAccess`: an agent the caller can't see answers the
// same 404 as one that doesn't exist. A change that decides which recipe runs and makes anything less safe answers
// `202 { status: "NEEDS_CONFIRMATION", confirmUrl, changes }` and changes nothing until a person confirms it on the page (changes.ts).
import { usdToWholeMicrodollars } from "../org/budget-amount.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AgentGuardrailsWriteSchema,
  AgentPublishBodySchema as PublishBodySchema,
  AgentRollbackBodySchema as RollbackBodySchema,
  AgentBudgetBodySchema as BudgetBodySchema,
  AgentRunBodySchema as RunBodySchema,
  AgentCreateBodySchema as CreateBodySchema,
  AgentDraftPutBodySchema as PutDraftBodySchema,
  AgentIdSchema,
  AgentOwnerSchema,
  AgentXNameSchema,
  BUILTIN_AGENTS,
  ModelSourceIdSchema,
  SkillIdSchema,
  SpendPolicyFieldsSchema,
  SpendPolicySchema,
  TRIAL_LIMITS_R49,
  AgentXError,
  agentXError,
  atLeast,
  canonicalJson,
  defaultModelSourceOrder,
  diffRecipes,
  isBuiltinAgentId,
  memberAcceptRunLimitUsd,
  projectAllows,
  recipeRunner,
  type AgentAccessLevel,
  type AgentId,
  type AgentOwner,
  type BaseRef,
  type BuiltinAgentId,
  type ChainId,
  type OrgId,
  type OwnerCapChange,
  type ProjectAiSettings,
  type ResolvedRecipe,
  type RunInput,
} from "@agentx/contracts";
import type { RoutingDependencies } from "../model-sources/routing.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import {
  agentAccess,
  listVisibleAgents,
  orgRoleOf,
  requireAgentAccess,
  requireAccountable,
  requireAgentBudgetAllowed,
  requireOwnerAllowed,
  resolveSurvivor,
  whoNeeds,
  type AccessibleAgent,
  type AgentCaller,
  type AgentScope,
} from "./access.js";
import { isApprovalRoute, routeApprovalRequest } from "./approval-routes.js";
import { PUBLISH_REQUESTS_PATH, routeAgentPublishRequests, routePublishRequests } from "./publication-routes.js";
import { isMyAgentsRoute, routeMyAgents } from "./favourites.js";
import { publicationOf, registerPublicationApprovals, requireOwnerOrAdminToMoveShared } from "./publication.js";
import { COMMENT_TRIGGERS_PATH, routeCommentTriggers } from "./comment-trigger-routes.js";
import { CONTEXT_SOURCES_PATH, routeContextSources, type ContextSourceRouteDependencies } from "../context-sources/settings-routes.js";
import { MCP_SERVERS_PATH, routeMcpServers } from "../context-sources/mcp-server-routes.js";
import type { McpServerDependencies } from "../context-sources/mcp-servers.js";
import { listOptOutViews, registerCommentTriggerApprovals } from "./comment-trigger-optouts.js";
import { requireNotCurrentProcess } from "../playbook/process-in-use.js";
import { diffLessSafe } from "../playbook/process-diff.js";
import { adoptBuiltin, publishDraft, registerAgentApprovals, resolveBase, resolveRecipe, rollbackAgent, shareAgent, updateGuardrails, versionSafety, type ChangeResult } from "./changes.js";
import { taskResponseForClient } from "../rovara-code/task-view-compat.js";
import { NEEDS_OWNER_APPROVAL, gateRunVersion, registerRunVersionApproval } from "./run-version-gate.js";
import type { ApprovalDependencies } from "./approvals.js";
import { log as logEvent } from "./approvals-store.js";
import { validateRecipeForOrg, readGuardrails, readGuardrailsWithRevision, requireBaseEnabled } from "./guardrails.js";
import { lessSafeChanges } from "./less-safe.js";
import { newOriginMemo, originView, withOriginView } from "../agent-sessions/origin.js";
import type { PullRequestHeadReader } from "./runs.js";
import { addToRoster, checkRosterChange, listRoster, removeFromRoster, roleOnProject, rosterAgentView, type RosterEntry } from "./roster.js";
import type { SkillRecord } from "./skills.js";
import type { OrgStore } from "../org/store.js";
import type { ChainTriggerHooks } from "../chains/routes.js";
import type { ChainStore } from "../chains/store.js";
import type { TriggerStore } from "../triggers/store.js";
import { routeEventHooks, type EventHookDependencies } from "../triggers/hooks.js";
import { routeAgentTriggers, routeBuiltinTriggers } from "../triggers/routes.js";
import type { ChainRunSpendReader } from "../spend/chain-run-spend.js";
import type { ChainRunPorts } from "../chains/runner.js";
import type { ChainViewPorts } from "../chains/view.js";
import { suggestMaxPerRun, type RequestRunLimit } from "../spend/estimate.js";
import { ownerShare, withBudgetFields } from "../spend/owner-total.js";
import { routeSpendRequest } from "../spend/routes.js";
import { isSpendRequestRoute, requestOwnerCap, routeSpendRequests, type SpendRequestHost } from "../spend/requests.js";
import { ownerCapCheck } from "./owner-cap-check.js";
import { isConnectionRoute, routeConnectionRequest, type ConnectionRouteDependencies } from "../connections/routes.js";
import { isProjectConnectorRoute, registerProjectConnectorApprovals, routeProjectConnectorRequest } from "../connections/project-connectors.js";
import { routeModelSourceRequest, type ModelSourceRouteDependencies } from "../model-sources/routes.js";
import {
  applyProjectAiChange, planningLimit, projectSourceOrder, readProjectAiWithRevision, readSpendPolicy, readSpendPolicyWithRevision,
  writeProjectAi, writeSpendPolicy, type ProjectAiChange,
} from "../spend/settings.js";
import { isOwnerCapRefusal, updateAvailable, type AgentDraft, type AgentRecord, type AgentVersion, type BuiltinSettings, type OwnerCap, type RequestMark, resolveAgent } from "./store.js";

/** What every agent route needs: the store, access, the approvals core and where the confirmation page lives. */
export interface AgentRouteDependencies extends ApprovalDependencies {
  /** Existing native sign-in table, supplied only at server wiring. */
  projectAiSignInTableName?: string;
  /** Read-only model source routing used by the member picker. */
  modelRouting?: RoutingDependencies;
  /** Plan 4 Task 4: the chain store, built on this agent store (so a person's agent and chain budgets are one total). Absent where chains are not set up: their routes then answer 404. */
  chains?: ChainStore;
  /** Plan 4 Task 18: the trigger store, which the trigger routes, the rechecks and the member movers work on. Absent where triggers are not set up: their routes then answer 404. */
  triggers?: TriggerStore;
  /** Plan 4 Task 19: the event hooks of a project (`/v1/app/projects/{p}/event-hooks*`). Absent where hooks are not set up: those routes then answer 404. */
  eventHooks?: EventHookDependencies;
  /** Plan 4 Tasks 18 and 20: what the chain routes ask of the trigger code. Absent until it exists: a chain then has no triggers. */
  chainTriggers?: ChainTriggerHooks;
  /** Plan 4 Task 6: what a chain run says about one of its steps (the chain, and the limit the run had left at the step's start), for who approves a step's raise. Absent: every chain step's raise is read as a run-level raise. */
  chainRunBudgets?: ChainRunSpendReader;
  /** Plan 4 Task 6: what the chain runner asks of Plan 3's run start and of the people a run names. Absent: chain runs can't be started and the routes answer NOT_FOUND. */
  chainRuns?: ChainRunPorts;
  /** Plan 4 Task 10: what the chain-run view asks of the task layer (a step task's view, its cost and open approvals). Absent: the view has no cost and a step's task can't be read. */
  chainView?: ChainViewPorts;
  /** Where the org's plan is read (Task 28): a trial org keeps the placeholder limits (R49). Without it no org is a trial. */
  orgs?: Pick<OrgStore, "getOrg">;
  /** Whether the install is a cloud one, whose orgs start with the placeholder monthly limits (R47); the spend routes show limits accordingly. */
  cloud?: boolean;
  /**
   * The model sources the org tries, in order (Task 26 supplies it). A project's own order may only name sources in it, and a project
   * with none follows it. Without it the order is Rovara's own AI alone.
   */
  orgSourceOrder?: (orgId: OrgId) => Promise<readonly string[]>;
  /** The company AI source routes' dependencies (Task 24b). Absent where there is no model proxy: those routes then say so. */
  modelSources?: ModelSourceRouteDependencies;
  /** Reads a pull request's head commit for a run whose context names one (Task 15); the broker supplies the GitHub App's. */
  pullRequestHead?: PullRequestHeadReader;
  /** Task 34's seam to Task 32: makes the `run_limit` request when approving a plan needs a higher tier than the approver's; the developer API reads it from here (`AgentRunDependencies.requestRunLimit`). */
  requestRunLimit?: RequestRunLimit;
  /** Task 12b: the org's connections (`/v1/app/connections*`). Without it (no connection secrets role) those routes answer NOT_FOUND. */
  connections?: ConnectionRouteDependencies["store"];
  /** Lane E (MCP context sources): the settings of a project's sources (`/v1/app/projects/{p}/context-sources*`). Absent where they are not set up: those routes then answer 404. */
  contextSources?: ContextSourceRouteDependencies;
  /** Lane E (Enterprise): the org's MCP servers on its own network (`/v1/app/org/mcp-servers*`). Absent where they are not set up: those routes then answer 404. */
  mcpServers?: McpServerDependencies;
  /** Plan 4 Task 16: the broker function's role ARN, for the trust policy a CloudWatch connection shows. */
  brokerRoleArn?: string;
  /** Starts a person's run (Task 15). The developer API supplies it, since it holds the task start; without it the route answers NOT_FOUND. */
  startRun?: (caller: AgentCaller, input: { requestId: string; project: string; agent: { agentId: AgentId; version?: number | "draft" }; input: RunInput }) => Promise<{ task: unknown }>;
  /** Task 32: what a spend request's approval does with the task it is about (the developer tasks' resume and continue-as-task). */
  spendRequests?: SpendRequestHost;
}

/**
 * `POST /v1/app/agents/{id}/runs` [`use`]: a person starts a run of the agent on a project. Access to the project, to the agent, the roster and the
 * guardrails are checked by the start itself, before anything is charged (an agent the caller can't see answers the same 404 as one that doesn't exist).
 */
async function startRun(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown, headers: Record<string, string | undefined>): Promise<StatusReply> {
  if (deps.startRun === undefined) throw agentXError("NOT_FOUND", "starting runs is not set up in this deployment");
  const input = parseBody(RunBodySchema, body);
  // A version that is not the current one and is less safe than it waits for the agent's owner (owner decision 2026-10-22): nothing starts until they OK it.
  const waitingForOwner = await gateRunVersion(deps, caller, { requestId: input.requestId, project: input.project, agent: { agentId, ...(input.version === undefined ? {} : { version: input.version }) }, input: input.input, origin: "app" });
  if (waitingForOwner !== undefined) return new StatusReply(202, { status: NEEDS_OWNER_APPROVAL, confirmUrl: waitingForOwner.confirmUrl, changes: waitingForOwner.changes });
  const started = await deps.startRun(caller, {
    requestId: input.requestId, project: input.project, input: input.input,
    agent: { agentId, ...(input.version === undefined ? {} : { version: input.version }) },
  });
  // Rovara Code (Plan 6): a client that does not send `x-agentx-task-view: 2` reads a version 1 projection of the task.
  return new StatusReply(202, taskResponseForClient({ task: started.task }, headers));
}

/** The answer for a change waiting on the page. */
const waiting = (result: Extract<ChangeResult<unknown>, { applied: false }>): StatusReply =>
  new StatusReply(202, { status: "NEEDS_CONFIRMATION", confirmUrl: result.confirmUrl, changes: result.changes });

// ---- which paths are Plan 3's

/**
 * The paths Plan 3 owns under `/v1/app/`, which the developer API sends here before its own handlers (PF24): a project's agents, AI,
 * spend and connectors, however deep, match before Plan 2's `/v1/app/projects/{name}*` routes.
 */
export function isAgentRoute(pathname: string): boolean {
  return /^\/v1\/app\/(agents|skills|approvals|spend-requests|connections|budget|agent-publish-requests)(\/|$)/.test(pathname)
    || /^\/v1\/app\/me\/agents(\/|$)/.test(pathname)
    || /^\/v1\/app\/org\/(agent-guardrails|model-sources|model-sources-order|spend|spend-policy|mcp-servers)(\/|$)/.test(pathname)
    || /^\/v1\/app\/tasks\/[^/]+\/(continue-as-task|run-limit-request)$/.test(pathname)
    || /^\/v1\/app\/projects\/[^/]+\/(agents|ai|spend|connectors|builtin-triggers|event-hooks|context-sources)(\/|$)/.test(pathname);
}

// ---- bodies

const RequestIdSchema = z.string().uuid();
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const DeveloperRefSchema = z.object({ developerId: Hex64 }).strict();

const PatchBodySchema = z.object({ requestId: RequestIdSchema, name: z.string().optional(), description: z.string().optional() }).strict();
const RequestOnlySchema = z.object({ requestId: RequestIdSchema }).strict();
const SharesBodySchema = z.object({ requestId: RequestIdSchema, shares: z.array(z.unknown()) }).strict();
const OwnerBodySchema = z.object({ requestId: RequestIdSchema, owner: AgentOwnerSchema, accountable: DeveloperRefSchema.optional() }).strict();
const AccountableBodySchema = z.object({ requestId: RequestIdSchema, accountable: DeveloperRefSchema }).strict();
const UpdateBaseBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: z.number().int().min(1) }).strict();
const AdoptBodySchema = z.object({ requestId: RequestIdSchema, version: z.number().int().min(1) }).strict();
const SkillCreateBodySchema = z.object({ requestId: RequestIdSchema, content: z.string(), name: z.string().optional(), owner: AgentOwnerSchema.optional() }).strict();
const SkillContentBodySchema = z.object({ requestId: RequestIdSchema, content: z.string(), expectedDigest: Hex64 }).strict();
const Amount = z.number().finite();
const ProjectAiBodySchema = z.object({
  requestId: RequestIdSchema,
  monthlyBudgetUsd: Amount.nullable().optional(),
  projectPays: z.boolean().optional(),
  sourceOrder: z.array(ModelSourceIdSchema).nullable().optional(),
  planningLimitUsd: z.object({ QUICK: Amount.nullable().optional(), FULL: Amount.nullable().optional() }).strict().optional(),
  memberAcceptRunLimitUpToUsd: Amount.nullable().optional(),
}).strict();
const SpendPolicyBodySchema = SpendPolicyFieldsSchema.partial().extend({ requestId: RequestIdSchema }).strict();
const GuardrailsBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: z.number().int().min(0), guardrails: AgentGuardrailsWriteSchema.refine(value => usdToWholeMicrodollars(value.maxPerRunCeilingUsd) !== undefined, { path: ["maxPerRunCeilingUsd"], message: "must have at most 6 decimal places" }) }).strict();

export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue?.message ?? "is not valid"}`);
}

const notFound = () => agentXError("NOT_FOUND", "no agent has that ID");

/** While an agent has a trigger that is on, changing the version it runs is for someone who manages it (Plan 4 Task 18). */
async function requireManagerWhileTriggered(deps: AgentRouteDependencies, agent: AgentRecord, access: AgentAccessLevel): Promise<void> {
  if (atLeast(access, "manage")) return;
  if (await deps.triggerHooks?.hasEnabledTriggers(agent.orgId, { kind: "agent", agentId: agent.agentId }) === true) {
    throw agentXError("FORBIDDEN", `${agent.name} has triggers turned on, so changing the version it runs needs ${whoNeeds(agent, "manage")}.`);
  }
}

/** `body`, with the triggers the change turned off when there are any: an answer that turned nothing off is the answer it always was. */
const withDisabled = <T extends object>(body: T, disabled: ReadonlyArray<unknown>): T | (T & { disabledTriggers: ReadonlyArray<unknown> }) => (disabled.length === 0 ? body : { ...body, disabledTriggers: disabled });

/** The triggers a change turned off because they no longer qualify, for the answer. The change itself has been made. */
async function recheck(deps: AgentRouteDependencies, orgId: OrgId, agentId: AgentId): Promise<Awaited<ReturnType<NonNullable<AgentRouteDependencies["triggerHooks"]>["recheckTriggersForTarget"]>>> {
  // The change was committed before this runs (L5): a failure is logged and the answer is the change that was made, without the list. A trigger left on is looked at again when it starts a run.
  try {
    return await deps.triggerHooks?.recheckTriggersForTarget(orgId, { kind: "agent", agentId }) ?? [];
  } catch (error) {
    logRecheckFailed(deps, { kind: "agent", id: agentId }, error);
    return [];
  }
}

/** A trigger re-check that failed after its change was committed (L5), through the route dependencies' logger (the event the trigger code logs for one trigger, with the target's kind and id; only the error's name). */
export function logRecheckFailed(deps: Pick<ApprovalDependencies, "log">, target: { kind: "agent" | "chain"; id: string }, error: unknown): void {
  logEvent(deps, "trigger_recheck.failed", { targetKind: target.kind, targetId: target.id, error: error instanceof Error ? error.name : "unknown" });
}

/** `requireAgentAccess` for reading an agent: a built-in the company turned off is not found by a member, as it is missing from their list; owners and admins still see it. */
async function requireReadableAgent(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, wanted: Parameters<typeof requireAgentAccess>[3]) {
  if (isBuiltinAgentId(agentId) && caller.orgRole !== "owner" && caller.orgRole !== "admin" && (await readGuardrails(deps, caller.orgId)).disabledBuiltins.some((id) => id === agentId)) throw notFound();
  return requireAgentAccess(deps, caller, agentId, wanted);
}

function agentIdOf(raw: string): AgentId {
  const parsed = AgentIdSchema.safeParse(raw);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

// ---- how an agent is shown

type Shown = Record<string, unknown>;

function customView(agent: AgentRecord, access: AgentAccessLevel): Shown {
  return {
    agentId: agent.agentId,
    name: agent.name,
    description: agent.description,
    builtin: false,
    owner: agent.owner,
    ...(agent.accountable === undefined ? {} : { accountable: agent.accountable }),
    ...(agent.currentVersion === undefined ? {} : { currentVersion: agent.currentVersion }),
    latestVersion: agent.latestVersion,
    draftRevision: agent.draftRevision,
    status: agent.status,
    ...(agent.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: agent.monthlyBudgetUsd }),
    ...(agent.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: agent.maxPerRunUsd }),
    createdBy: agent.createdBy,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    access,
  };
}

async function builtinView(deps: ApprovalDependencies, orgId: OrgId, agentId: AgentId, access: AgentAccessLevel, disabled: boolean, stored?: BuiltinSettings): Promise<Shown> {
  const template = BUILTIN_AGENTS[agentId as keyof typeof BUILTIN_AGENTS];
  const settings = stored ?? await deps.store.getBuiltinSettings(orgId, agentId);
  return {
    agentId,
    name: template.name,
    description: template.description,
    builtin: true,
    status: "active",
    ...(disabled ? { disabled: true } : {}),
    pinnedVersion: settings?.pinnedVersion ?? deps.store.builtinDefaultPin(agentId),
    latestVersion: deps.store.builtinLatestVersion(agentId),
    ...(template.needsLaterConnectors === undefined ? {} : { needsLaterConnectors: template.needsLaterConnectors }),
    ...(settings?.accountable === undefined ? {} : { accountable: settings.accountable }),
    ...(settings?.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: settings.monthlyBudgetUsd }),
    ...(settings?.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: settings.maxPerRunUsd }),
    access,
  };
}

export async function view(deps: ApprovalDependencies, caller: AgentCaller, agent: AccessibleAgent, access?: AgentAccessLevel, disabled?: boolean, settings?: BuiltinSettings): Promise<Shown> {
  const level = access ?? await agentAccess(deps, caller, agent);
  if ("owner" in agent) return customView(agent, level);
  return builtinView(deps, caller.orgId, agent.agentId, level, disabled ?? (await readGuardrails(deps, caller.orgId)).disabledBuiltins.some((id) => id === agent.agentId), settings);
}

/**
 * What the agent's page suggests as its max per run (Task 34): twice the p80 of its last runs once it has five, else twice the high end of the default for
 * its usual path (FULL for a coding recipe, AGENT otherwise). Display only.
 */
const suggestedMaxPerRunUsd = (deps: AgentRouteDependencies, orgId: OrgId, agentId: AgentId, recipe: ResolvedRecipe | undefined): Promise<number> =>
  suggestMaxPerRun({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, { orgId, agentId, coding: recipe !== undefined && recipeRunner(recipe) === "coding" });

// ---- reads

const SCOPES = ["all", "mine", "shared", "builtin"] as const;

function scopeOf(url: URL): AgentScope {
  const project = url.searchParams.get("project");
  if (project !== null) {
    const parsed = AgentXNameSchema.safeParse(project);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "project: not a project name");
    return { project: parsed.data };
  }
  const scope = url.searchParams.get("scope") ?? "all";
  if (!(SCOPES as readonly string[]).includes(scope)) throw agentXError("CONFIG_INVALID", `scope: must be one of ${SCOPES.join(", ")}`);
  return scope as (typeof SCOPES)[number];
}

async function listAgents(deps: AgentRouteDependencies, caller: AgentCaller, url: URL): Promise<{ agents: Shown[] }> {
  const agents: Shown[] = [];
  for (const visible of await listVisibleAgents(deps, caller, scopeOf(url))) {
    const summary = await view(deps, caller, visible.record ?? { agentId: visible.agentId } as AccessibleAgent, visible.access, visible.disabled === true);
    if (visible.record !== undefined) {
      // Only those who can change the agent see the base it builds on and that it has an update.
      const draft = atLeast(visible.access, "edit") ? await deps.store.getDraft(caller.orgId, visible.agentId) : undefined;
      const extendsRef = draft?.extends ?? (visible.record.currentVersion === undefined ? undefined : (await deps.store.getVersion(caller.orgId, visible.agentId, visible.record.currentVersion))?.extends);
      const update = draft === undefined ? undefined : await updateAvailable(deps.store, caller.orgId, visible.agentId);
      Object.assign(summary, extendsRef === undefined ? {} : { extends: extendsRef }, update === undefined ? {} : { updateAvailable: update }, { publication: await publicationOf(deps, caller, visible.record) });
    }
    agents.push(summary);
  }
  return { agents };
}

async function getAgent(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId): Promise<Shown> {
  const { agent, access } = await requireReadableAgent(deps, caller, agentId, "view");
  const shown = await view(deps, caller, agent, access);
  if ("owner" in agent) shown["publication"] = await publicationOf(deps, caller, agent);
  if (!("owner" in agent)) {
    const version = shown["pinnedVersion"] as number;
    const recipe = deps.store.builtinRecipe(agentId, version);
    return { agent: shown, current: { version, recipe, changed: false }, suggestedMaxPerRunUsd: await suggestedMaxPerRunUsd(deps, caller.orgId, agentId, recipe), ...(shown["maxPerRunUsd"] === undefined ? {} : { maxPerRunUsd: shown["maxPerRunUsd"] }) };
  }
  // A published version that can't be resolved now (the agent it builds on was archived since) is reported beside the agent, not as a failure to show it.
  let current: ResolvedRecipe | undefined;
  let currentProblem: string | undefined;
  if (agent.currentVersion !== undefined) {
    try {
      current = await resolveRecipe(deps, caller.orgId, agentId, agent.currentVersion);
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      currentProblem = error.message.replace(`${error.code}: `, "");
    }
  }
  let changed = false;
  if (current !== undefined && atLeast(access, "edit")) {
    // Whether the draft differs from what runs: a draft that can't be resolved yet has changed too. Below edit the draft is not theirs to see.
    changed = await resolveRecipe(deps, caller.orgId, agentId, "draft").then((draft) => diffRecipes(current, draft).length > 0, () => true);
  }
  return {
    agent: shown,
    ...(agent.currentVersion === undefined ? {} : { current: { version: agent.currentVersion, ...(current === undefined ? {} : { recipe: current }), changed, ...(currentProblem === undefined ? {} : { problem: currentProblem }) } }),
    suggestedMaxPerRunUsd: await suggestedMaxPerRunUsd(deps, caller.orgId, agentId, current),
    ...(agent.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: agent.maxPerRunUsd }),
  };
}

/** What a version list says of one version against the one that runs now (owner decision 2026-10-22): `current`, `same_or_safer` (a run may use it as it is) or `less_safe` (a run of it needs the owner's OK; `lessSafe` says why). */
async function safetyMarks(deps: AgentRouteDependencies, orgId: OrgId, agentId: AgentId, agent: AgentRecord | undefined, versions: readonly number[]): Promise<Map<number, Shown>> {
  const marks = new Map<number, Shown>();
  for (const version of versions) {
    try {
      const { safety } = await versionSafety(deps, orgId, agentId, version, agent);
      marks.set(version, safety.kind === "less_safe" ? { safety: "less_safe", needsOwnerOk: true, lessSafe: safety.changes } : { safety: safety.kind, needsOwnerOk: false });
    } catch (error) {
      // A version that can't be resolved now (the agent it builds on was archived): it can't run either, and the list still shows it.
      if (!(error instanceof AgentXError)) throw error;
      marks.set(version, { safety: "unknown", needsOwnerOk: false, problem: error.message.replace(`${error.code}: `, "") });
    }
  }
  return marks;
}

async function listVersions(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId): Promise<{ versions: Shown[] }> {
  const { agent } = await requireReadableAgent(deps, caller, agentId, "view");
  if (!("owner" in agent)) {
    const pinned = (await deps.store.getBuiltinSettings(caller.orgId, agentId))?.pinnedVersion ?? deps.store.builtinDefaultPin(agentId);
    const releases = BUILTIN_AGENTS[agentId as keyof typeof BUILTIN_AGENTS].versions;
    const marks = await safetyMarks(deps, caller.orgId, agentId, undefined, releases.map((release) => release.version));
    return { versions: releases.map((release) => ({ version: release.version, digest: release.digest, releasedIn: release.releasedIn, notes: release.notes, current: release.version === pinned, ...marks.get(release.version) })) };
  }
  const versions = await deps.store.listVersions(caller.orgId, agentId);
  const marks = await safetyMarks(deps, caller.orgId, agentId, agent, versions.map((version) => version.version));
  // Where each version came from, as this person may read it now (Task 10c): one read of the session for all the versions made from it.
  const memo = newOriginMemo();
  const origins = new Map<number, unknown>();
  for (const version of versions) origins.set(version.version, await originView(deps, caller, version.origin, memo));
  return {
    versions: versions.map((version) => ({
      version: version.version, name: version.name, description: version.description, digest: version.digest,
      publishedBy: version.publishedBy, publishedAt: version.publishedAt, ...(version.note === undefined ? {} : { note: version.note }),
      ...(version.extends === undefined ? {} : { extends: version.extends }), ...(origins.get(version.version) === undefined ? {} : { origin: origins.get(version.version) }),
      current: version.version === agent.currentVersion, ...marks.get(version.version),
    })),
  };
}

async function getVersion(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, version: number): Promise<Shown> {
  const { agent } = await requireReadableAgent(deps, caller, agentId, "view");
  if (!("owner" in agent)) {
    const release = BUILTIN_AGENTS[agentId as keyof typeof BUILTIN_AGENTS].versions.find((entry) => entry.version === version);
    if (release === undefined) throw agentXError("NOT_FOUND", `${deps.store.builtinName(agentId)} has no version ${String(version)}`);
    return { version: { version, digest: release.digest, releasedIn: release.releasedIn, notes: release.notes }, recipe: deps.store.builtinRecipe(agentId, version) };
  }
  const stored = await deps.store.getVersion(caller.orgId, agentId, version);
  if (stored === undefined) throw agentXError("NOT_FOUND", `${agent.name} has no version ${String(version)}`);
  return { version: { ...await withOriginView(deps, caller, stored), current: stored.version === agent.currentVersion }, recipe: await resolveRecipe(deps, caller.orgId, agentId, version) };
}

function diffSpec(raw: string | null, name: "from", base: true): number | "base" | "draft";
function diffSpec(raw: string | null, name: "to", base: false): number | "draft";
function diffSpec(raw: string | null, name: "from" | "to", base: boolean): number | "base" | "draft" {
  if (raw === "draft" || (raw === "base" && base)) return raw;
  if (raw !== null && /^[1-9][0-9]{0,5}$/.test(raw)) return Number(raw);
  throw agentXError("CONFIG_INVALID", `${name}: must be ${base ? "a version number, base or draft" : "a version number or draft"}`);
}

async function diffAgent(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, url: URL): Promise<Shown> {
  const from = diffSpec(url.searchParams.get("from"), "from", true);
  const to = diffSpec(url.searchParams.get("to"), "to", false);
  // The draft is the editors' to see.
  const { agent } = await requireReadableAgent(deps, caller, agentId, from === "draft" || to === "draft" ? "edit" : "view");
  const orgId = caller.orgId;
  const recipeOf = async (spec: number | "base" | "draft"): Promise<ResolvedRecipe> => {
    if (!("owner" in agent)) {
      if (typeof spec !== "number") throw agentXError("CONFIG_INVALID", "from: a built-in agent has no base");
      return deps.store.builtinRecipe(agentId, spec);
    }
    // The base is what the agent builds on at the version being compared to.
    if (spec === "base") return resolveBase(deps, orgId, (to === "draft" ? await deps.store.getDraft(orgId, agentId) : await deps.store.getVersion(orgId, agentId, to))?.extends);
    return resolveRecipe(deps, orgId, agentId, spec);
  };
  const before = await recipeOf(from);
  const after = await recipeOf(to);
  return { from, to, changes: diffRecipes(before, after), lessSafe: "owner" in agent ? diffLessSafe(agent, before, after, from) : lessSafeChanges(before, after), comparison: { before, after } };
}

// ---- repeated requests (R18)

/**
 * What a request is, apart from its id: the route, the agent and the rest of the body. The same request id for a different one is a mistake.
 */
function fingerprintOf(route: string, agentId: string, body: { requestId: string }): string {
  const { requestId: _requestId, ...rest } = body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the id is the key, not part of what was asked
  return createHash("sha256").update(canonicalJson({ route, agentId, body: rest }), "utf8").digest("hex");
}

/**
 * The mark a write carries, and what it did the last time this developer sent this request (`replay`), if it did anything. The store
 * writes the mark in the same transaction as the change, so a request that changed something is answered from it, and a refused or
 * waiting one (an approval has its own replay) leaves none. Called after the access checks: a repeat tells nobody who lost access anything.
 */
export async function markRequest(deps: Pick<ApprovalDependencies, "store">, caller: AgentCaller, route: string, agentId: string, body: { requestId: string }): Promise<{ mark: RequestMark; replay?: { result: unknown } }> {
  const mark: RequestMark = { orgId: caller.orgId, developerId: caller.developerId, requestId: body.requestId, fingerprint: fingerprintOf(route, agentId, body) };
  const earlier = await deps.store.getRequest(caller.orgId, caller.developerId, body.requestId);
  if (earlier === undefined) return { mark };
  if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
  return { mark, replay: { result: earlier.result } };
}

// ---- writes

async function createAgent(deps: AgentRouteDependencies, caller: AgentCaller, body: unknown): Promise<StatusReply> {
  const input = parseBody(CreateBodySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "create", "", input);
  if (replay !== undefined) {
    // The agent as it is now, if the caller can still see it: a repeat is not a way to read what they no longer have.
    const { agent, access } = await requireAgentAccess(deps, caller, (replay.result as AgentRecord).agentId, "view");
    return new StatusReply(201, { agent: await view(deps, caller, agent, access) });
  }
  const owner: AgentOwner = input.owner ?? { kind: "member", developerId: caller.developerId };
  const stored = await requireOwnerAllowed(deps, caller, owner);
  // A project's accountable maintainer must be able to manage its agents; a member's agent has none (the store refuses one).
  const accountable = input.accountable === undefined ? undefined : stored.kind === "project" ? await requireAccountable(deps, caller.orgId, stored.project, input.accountable.developerId) : input.accountable;
  if (input.extends !== undefined) {
    await requireAgentAccess(deps, caller, input.extends, "use");
    await requireBaseEnabled(deps, caller.orgId, input.extends);
  }
  const agent = await deps.store.create({
    orgId: caller.orgId, name: input.name, owner: stored, createdBy: caller.developerId,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(accountable === undefined ? {} : { accountable }),
    ...(input.extends === undefined ? {} : { extends: input.extends }),
    ...(input.overlay === undefined ? {} : { overlay: input.overlay }),
    request: mark,
  });
  return new StatusReply(201, { agent: await view(deps, caller, agent) });
}

async function patchAgent(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(PatchBodySchema, body);
  if (input.name === undefined && input.description === undefined) throw agentXError("CONFIG_INVALID", "body: change a name or a description");
  const { access } = await requireAgentAccess(deps, caller, agentId, "edit");
  const { mark, replay } = await markRequest(deps, caller, "patch", agentId, input);
  if (replay !== undefined) return { agent: customView(replay.result as AgentRecord, access) };
  const agent = await deps.store.updateProfile({
    orgId: caller.orgId, agentId, by: caller.developerId, request: mark,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
  });
  return { agent: customView(agent, access) };
}

async function getDraft(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId): Promise<Shown> {
  await requireAgentAccess(deps, caller, agentId, "edit");
  const draft = await deps.store.getDraft(caller.orgId, agentId);
  if (draft === undefined) throw notFound();
  // RULING Q48: invalid drafts remain inspectable; publication still validates.
  const problems: Array<{path:string;message:string}> = [];
  try {
    const resolved = await resolveAgent(deps.store, caller.orgId, agentId, "draft", { draft, problems, ...(deps.resolveSkill === undefined ? {} : { resolveSkill: deps.resolveSkill }) });
    for (const problem of await validateRecipeForOrg(deps, caller.orgId, resolved)) if (!problems.some(p => p.path === problem.path && p.message === problem.message)) problems.push(problem);
    problems.sort((a,b)=>a.path.localeCompare(b.path)||a.message.localeCompare(b.message));
    return { draft: await withOriginView(deps, caller, draft), resolved, base: await resolveBase(deps, caller.orgId, draft.extends), problems };
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    return { draft: await withOriginView(deps, caller, draft), problems: [{ path: /skill/i.test(error.message) ? "skills" : "extends", message: error.message.replace(`${error.code}: `, "") }] };
  }
}

async function putDraft(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(PutDraftBodySchema, body);
  await requireAgentAccess(deps, caller, agentId, "edit");
  const { mark, replay } = await markRequest(deps, caller, "draft", agentId, input);
  if (replay !== undefined) return { draft: await withOriginView(deps, caller, replay.result as AgentDraft) };
  // Building on another agent needs `use` on it; keeping the base it already has does not.
  if (typeof input.extends === "string" && input.extends !== (await deps.store.getDraft(caller.orgId, agentId))?.extends?.agentId) {
    await requireAgentAccess(deps, caller, input.extends, "use");
    await requireBaseEnabled(deps, caller.orgId, input.extends);
  }
  const draft = await deps.store.saveDraft({
    orgId: caller.orgId, agentId, overlay: input.overlay, expectedRevision: input.expectedRevision, by: caller.developerId, request: mark,
    ...(input.extends === undefined ? {} : { extends: input.extends }),
  });
  return { draft: await withOriginView(deps, caller, draft) };
}

async function publishAgent(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<unknown> {
  const input = parseBody(PublishBodySchema, body);
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "edit");
  if (!("owner" in agent)) throw notFound();
  await requireManagerWhileTriggered(deps, agent, access);
  const { mark, replay } = await markRequest(deps, caller, "publish", agentId, input);
  if (replay !== undefined) return { version: await withOriginView(deps, caller, replay.result as AgentVersion), agent: customView(await deps.store.get(caller.orgId, agentId) ?? agent, access) };
  const result = await publishDraft(deps, caller, agent, { ...input, request: mark });
  if (!result.applied) return waiting(result);
  return withDisabled({ version: await withOriginView(deps, caller, result.value), agent: customView(await deps.store.get(caller.orgId, agentId) ?? agent, access) }, await recheck(deps, caller.orgId, agentId));
}

async function rollback(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<unknown> {
  const input = parseBody(RollbackBodySchema, body);
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "edit");
  if (!("owner" in agent)) throw notFound();
  await requireManagerWhileTriggered(deps, agent, access);
  const { mark, replay } = await markRequest(deps, caller, "rollback", agentId, input);
  if (replay !== undefined) return { agent: customView(replay.result as AgentRecord, access) };
  const result = await rollbackAgent(deps, caller, agent, { ...input, request: mark });
  return result.applied ? withDisabled({ agent: customView(result.value, access) }, await recheck(deps, caller.orgId, agentId)) : waiting(result);
}

async function setArchived(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown, archive: boolean): Promise<Shown | StatusReply> {
  const input = parseBody(RequestOnlySchema, body);
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "manage");
  const guard = archive && "owner" in agent ? await requireNotCurrentProcess(deps, agent) : undefined;
  const { mark, replay } = await markRequest(deps, caller, archive ? "archive" : "unarchive", agentId, input);
  if (replay !== undefined) return waitingReplay(replay.result) ?? { agent: customView(replay.result as AgentRecord, access) };
  if (archive) {
    // Archiving holds the person to the access this route checked, at the commit: still a member in this role, the company open, and the agent still the one they could manage.
    const archived = await deps.store.archive(caller.orgId, agentId, caller.developerId, mark, {
      actor: { developerId: caller.developerId, role: caller.orgRole }, ...("owner" in agent ? { manageSnapshot: agent } : {}), ...(guard === undefined ? {} : { checks: guard }),
    });
    // An archived agent starts nothing, so its triggers go off with it. Unarchiving turns none back on: a person does that.
    await deps.triggerHooks?.disableTriggersForTarget(caller.orgId, { kind: "agent", agentId });
    return { agent: customView(archived, access) };
  }
  // Unarchiving puts the agent's budget back in its owner's total; an archived agent's budget counted for no one.
  const current = await deps.store.get(caller.orgId, agentId);
  const unarchived = current === undefined || current.status !== "archived"
    ? await deps.store.unarchive(caller.orgId, agentId, caller.developerId, mark, { actor: { developerId: caller.developerId, role: caller.orgRole }, ...(current === undefined ? {} : { manageSnapshot: current }) })
    : await holdingCap(deps, caller, agentId, current, withBudgetFields(current, { status: "active" }), { op: "unarchive" }, mark, (options) => deps.store.unarchive(caller.orgId, agentId, caller.developerId, mark, { ...options, actor: { developerId: caller.developerId, role: caller.orgRole }, manageSnapshot: current }));
  if (unarchived instanceof StatusReply) return unarchived;
  return { agent: customView(unarchived, access) };
}

async function getShares(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId): Promise<Shown> {
  await requireAgentAccess(deps, caller, agentId, "manage");
  return { shares: (await deps.store.listShares(caller.orgId, agentId)).map(({ principal, level, grantedBy, grantedAt }) => ({ principal, level, grantedBy, grantedAt })) };
}

async function putShares(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<unknown> {
  const input = parseBody(SharesBodySchema, body);
  if (isBuiltinAgentId(agentId)) throw agentXError("CONFIG_INVALID", "Built-in agents belong to the whole company and can't be shared.");
  const { agent } = await requireAgentAccess(deps, caller, agentId, "manage");
  if (!("owner" in agent)) throw notFound();
  const { mark, replay } = await markRequest(deps, caller, "shares", agentId, input);
  if (replay !== undefined) return { shares: replay.result };
  const result = await shareAgent(deps, caller, agent, { ...input, request: mark });
  return result.applied ? { shares: result.value } : waiting(result);
}

async function putOwner(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown | StatusReply> {
  const input = parseBody(OwnerBodySchema, body);
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "manage");
  if (!("owner" in agent)) throw agentXError("CONFIG_INVALID", `${deps.store.builtinName(agentId)} is built in and belongs to the whole company`);
  const { mark, replay } = await markRequest(deps, caller, "owner", agentId, input);
  if (replay !== undefined) return waitingReplay(replay.result) ?? { agent: customView(replay.result as AgentRecord, access) };
  // Decision 92: a company-shared agent changes owner only by an org owner or admin.
  await requireOwnerOrAdminToMoveShared(deps, caller.orgId, agentId, caller.orgRole);
  // Store the owner this returns, not the one asked for: a member who was merged into another is named by the survivor.
  const owner = await requireOwnerAllowed(deps, caller, input.owner, agent.owner);
  const accountable = input.accountable === undefined ? undefined : owner.kind === "project" ? await requireAccountable(deps, caller.orgId, owner.project, input.accountable.developerId) : input.accountable;
  // The agent's budget leaves its owner's total and joins the new owner's (the maintainer accountable for a project's agent).
  const { accountable: _before, ...kept } = agent; // eslint-disable-line @typescript-eslint/no-unused-vars -- the new owner decides it
  const change: OwnerCapChange = { op: "set_owner", owner, ...(accountable === undefined ? {} : { accountable }) };
  const updated = await holdingCap(deps, caller, agentId, agent, { ...kept, owner, ...(accountable === undefined ? {} : { accountable }) }, change, mark, (options) => deps.store.setOwner(caller.orgId, agentId, owner, caller.developerId, accountable, mark, { ...options, actor: { developerId: caller.developerId, role: caller.orgRole }, manageSnapshot: agent }));
  if (updated instanceof StatusReply) return updated;
  // A custom agent runs as its owner, so its triggers are looked at again for the new one: those they can't run are turned off, and the answer says which.
  return withDisabled({ agent: customView(updated, access) }, await recheck(deps, caller.orgId, agentId));
}

async function putAccountable(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown | StatusReply> {
  const input = parseBody(AccountableBodySchema, body);
  const { agent } = await requireAgentAccess(deps, caller, agentId, "manage");
  const { mark, replay } = await markRequest(deps, caller, "accountable", agentId, input);
  if (replay !== undefined) return waitingReplay(replay.result) ?? replay.result as Shown;
  let accountable: { developerId: string };
  if (!("owner" in agent)) {
    // A built-in has no project: its accountable person is one of the org's owners or admins.
    const survivor = await resolveSurvivor(deps, caller.orgId, input.accountable.developerId);
    const role = await orgRoleOf(deps, caller.orgId, survivor);
    if (role !== "owner" && role !== "admin") throw agentXError("CONFIG_INVALID", "accountable: pick an org owner or admin for a built-in agent");
    accountable = { developerId: survivor };
  } else if (agent.owner.kind === "project") {
    accountable = await requireAccountable(deps, caller.orgId, agent.owner.project, input.accountable.developerId);
  } else {
    throw agentXError("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
  }
  // The agent's budget moves from the old accountable maintainer's total to the new one's.
  const builtinSnapshot = "owner" in agent ? null : await deps.store.getBuiltinSettings(caller.orgId, agentId) ?? null;
  const current = "owner" in agent ? agent : builtinSnapshot ?? { pinnedVersion: deps.store.builtinDefaultPin(agentId), updatedBy: caller.developerId, updatedAt: new Date(deps.now()).toISOString() };
  const done = await holdingCap(deps, caller, agentId, current, withBudgetFields(current, { accountable }), { op: "set_accountable", accountable }, mark, (options) => deps.store.setAccountable(caller.orgId, agentId, accountable, caller.developerId, mark, "owner" in agent ? { ...options, actor: { developerId: caller.developerId, role: caller.orgRole }, manageSnapshot: agent } : { ...options, actor: { developerId: caller.developerId, role: caller.orgRole }, builtinSnapshot }));
  if (done instanceof StatusReply) return done;
  return { accountable };
}

async function updateBase(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(UpdateBaseBodySchema, body);
  await requireAgentAccess(deps, caller, agentId, "edit");
  const { mark, replay } = await markRequest(deps, caller, "update-base", agentId, input);
  const answer = async (draft: AgentDraft, previous: BaseRef | undefined): Promise<Shown> => {
    const moved = previous !== undefined && draft.extends !== undefined && draft.extends.version !== previous.version;
    return { draft: await withOriginView(deps, caller, draft), changes: moved ? diffRecipes(await resolveBase(deps, caller.orgId, previous), await resolveBase(deps, caller.orgId, draft.extends)) : [] };
  };
  if (replay !== undefined) return answer((replay.result as { draft: AgentDraft }).draft, (replay.result as { previous?: BaseRef }).previous);
  const before = (await deps.store.getDraft(caller.orgId, agentId))?.extends;
  // The base was needed to build on it once; moving to its newer version needs `use` on it still.
  if (before !== undefined) {
    await requireAgentAccess(deps, caller, before.agentId, "use");
    // Moving to a newer version is building on it again: not while the built-in it comes from is turned off.
    if (await updateAvailable(deps.store, caller.orgId, agentId) !== undefined) await requireBaseEnabled(deps, caller.orgId, before.agentId);
  }
  const draft = await deps.store.updateBase({ orgId: caller.orgId, agentId, expectedRevision: input.expectedRevision, by: caller.developerId, request: mark });
  return answer(draft, before);
}

async function adopt(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<unknown> {
  const input = parseBody(AdoptBodySchema, body);
  if (!isBuiltinAgentId(agentId)) throw agentXError("CONFIG_INVALID", "only a built-in agent has versions to adopt");
  // `manage` on a built-in is held by org owners and admins only.
  await requireAgentAccess(deps, caller, agentId, "manage");
  const { mark, replay } = await markRequest(deps, caller, "adopt", agentId, input);
  if (replay !== undefined) {
    const { settings, previous } = replay.result as { settings: BuiltinSettings; previous: number };
    return { pinnedVersion: settings.pinnedVersion, changes: diffRecipes(deps.store.builtinRecipe(agentId, previous), deps.store.builtinRecipe(agentId, settings.pinnedVersion)) };
  }
  const result = await adoptBuiltin(deps, caller, agentId, { ...input, request: mark });
  return result.applied ? withDisabled(result.value, await recheck(deps, caller.orgId, agentId)) : waiting(result);
}

// ---- skills (Task 9)

const skillNotFound = () => agentXError("NOT_FOUND", "no skill has that ID");

function skillView({ orgId: _orgId, ...skill }: SkillRecord): Shown { // eslint-disable-line @typescript-eslint/no-unused-vars -- the org is the caller's, never part of an answer
  return skill;
}

/** The skill's owner, an org owner or admin, or (for a project's skill) a maintainer who can manage the project's agents. */
async function mayChangeSkill(deps: AgentRouteDependencies, caller: AgentCaller, skill: SkillRecord): Promise<boolean> {
  if (caller.orgRole === "owner" || caller.orgRole === "admin") return true;
  if (skill.owner.kind === "member") return (await resolveSurvivor(deps, caller.orgId, skill.owner.developerId)) === caller.developerId;
  const role = await deps.projectMembers.roleOf(caller.orgId, skill.owner.project, { developerId: caller.developerId, orgRole: caller.orgRole });
  return role !== undefined && projectAllows(role, "manage_agents");
}

async function requireSkill(deps: AgentRouteDependencies, caller: AgentCaller, rawId: string): Promise<SkillRecord> {
  const id = SkillIdSchema.safeParse(rawId);
  const skill = id.success ? await deps.store.skills.get(caller.orgId, id.data) : undefined;
  if (skill === undefined) throw skillNotFound();
  return skill;
}

async function createSkill(deps: AgentRouteDependencies, caller: AgentCaller, body: unknown): Promise<StatusReply> {
  const input = parseBody(SkillCreateBodySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "skill-create", "", input);
  // R18: a repeat is answered with what the first request returned.
  if (replay !== undefined) return new StatusReply(201, { skill: skillView(replay.result as SkillRecord) });
  const owner = await requireOwnerAllowed(deps, caller, input.owner ?? { kind: "member", developerId: caller.developerId }, undefined, "a skill");
  const skill = await deps.store.skills.create({
    orgId: caller.orgId, content: input.content, owner, by: caller.developerId, request: mark,
    ...(input.name === undefined ? {} : { name: input.name }),
  });
  return new StatusReply(201, { skill: skillView(skill) });
}

async function getSkill(deps: AgentRouteDependencies, caller: AgentCaller, rawId: string): Promise<Shown> {
  const skill = await requireSkill(deps, caller, rawId);
  const version = await deps.store.skills.getVersion(caller.orgId, skill.skillId, skill.currentDigest);
  if (version === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "this skill's content can't be read right now");
  return { skill: { ...skillView(skill), canEdit: await mayChangeSkill(deps, caller, skill) }, content: version.content };
}

async function putSkillContent(deps: AgentRouteDependencies, caller: AgentCaller, rawId: string, body: unknown): Promise<Shown> {
  const input = parseBody(SkillContentBodySchema, body);
  const skill = await requireSkill(deps, caller, rawId);
  if (!await mayChangeSkill(deps, caller, skill)) {
    throw agentXError("FORBIDDEN", skill.owner.kind === "project" ? `Only the skill's owner, a maintainer of ${skill.owner.project}, or an org admin can change it.` : "Only the skill's owner or an org admin can change it.");
  }
  const { mark, replay } = await markRequest(deps, caller, "skill-content", skill.skillId, input);
  if (replay !== undefined) return { skill: skillView(replay.result as SkillRecord) };
  const updated = await deps.store.skills.putContent({ orgId: caller.orgId, skillId: skill.skillId, content: input.content, expectedDigest: input.expectedDigest, by: caller.developerId, request: mark });
  return { skill: skillView(updated) };
}

// ---- guardrails

const GUARDRAILS_PATH = "/v1/app/org/agent-guardrails";

async function putGuardrails(deps: AgentRouteDependencies, caller: AgentCaller, body: unknown): Promise<unknown> {
  // The caller's role was read from the membership for this request, not carried in the token.
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "Only an org owner or admin can change the company's agent guardrails.");
  const input = parseBody(GuardrailsBodySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "guardrails", "", input);
  if (replay !== undefined) return replay.result;
  const result = await updateGuardrails(deps, caller, { ...input, request: mark });
  // A built-in the company turned off starts nothing: the triggers of every built-in are looked at again.
  return result.applied ? withDisabled(result.value, await deps.triggerHooks?.recheckBuiltinTriggers(caller.orgId) ?? []) : waiting(result);
}

// ---- project rosters (Task 10)

/** Which agents work on a project. */
async function getRoster(deps: AgentRouteDependencies, caller: AgentCaller, project: string): Promise<Shown> {
  return { agents: await listRoster(deps, caller, project) };
}

async function putRosterAgent(deps: AgentRouteDependencies, caller: AgentCaller, project: string, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(RequestOnlySchema, body);
  const agent = await checkRosterChange(deps, caller, project, { add: agentId });
  // The project is part of what was asked, so the same request id for another project is a different request.
  const { mark, replay } = await markRequest(deps, caller, "roster-add", `${project}/${agentId}`, input);
  const entry = replay === undefined ? await addToRoster(deps, { orgId: caller.orgId, project, agentId, by: caller.developerId, request: mark }) : replay.result as RosterEntry;
  const shown = await rosterAgentView(deps, caller, entry);
  return { agent: shown ?? { agentId: agent?.agentId ?? agentId, addedBy: entry.addedBy, addedAt: entry.addedAt } };
}

async function deleteRosterAgent(deps: AgentRouteDependencies, caller: AgentCaller, project: string, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(RequestOnlySchema, body);
  await checkRosterChange(deps, caller, project, { remove: agentId });
  const { mark, replay } = await markRequest(deps, caller, "roster-remove", `${project}/${agentId}`, input);
  if (replay !== undefined) return replay.result as Shown;
  const removed = await removeFromRoster(deps, { orgId: caller.orgId, project, agentId, by: caller.developerId, request: mark });
  return withDisabled({ removed }, removed ? await recheck(deps, caller.orgId, agentId) : []);
}

// ---- budgets (Task 28)

const isOrgAdmin = (caller: AgentCaller) => caller.orgRole === "owner" || caller.orgRole === "admin";

/** R49 (`TRIAL_LIMITS_R49`): a trial org stays within the placeholder limits until billing exists. Nothing is read of the org unless the amount is over the cap. */
async function requireWithinTrial(deps: AgentRouteDependencies, orgId: OrgId, label: string, amount: number | null | undefined, capUsd: number, what: string): Promise<void> {
  if (typeof amount !== "number" || amount <= capUsd) return;
  if ((await deps.orgs?.getOrg(orgId))?.plan !== "trial") return;
  throw agentXError("CONFIG_INVALID", `${label}: a trial organization's ${what} is at most $${String(capUsd)} a month; upgrade the plan to raise it`);
}

/**
 * Runs a write that moves an agent's budget from `before` to `after`, held to the cap. A change that would take someone's effective total (their agent
 * budgets plus this month's top-ups, Task 33 fix round 1, I-1) past `ownerAgentBudgetCapUsd` (owners read as their survivors, the way the store counts
 * them) is not made: an org admin is asked with an `owner_cap`
 * request holding `change`, and the answer is `202 { status: "NEEDS_ADMIN_APPROVAL", spendRequestId, message }` (PF27). The same happens when the store
 * refuses it for the cap (the total moved after this read), with the figures as they are now. The request's R18 item is `mark`, so a repeat answers 202 again.
 */
function holdingCap<T>(
  deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, before: Parameters<typeof ownerShare>[0], after: Parameters<typeof ownerShare>[0],
  change: OwnerCapChange, mark: RequestMark, run: (options: { ownerCap: OwnerCap }) => Promise<T>,
): Promise<T | StatusReply> {
  return holdingOwnerCap(deps, caller, { kind: "agent", agentId }, before, after, change, mark, run);
}

/**
 * `holdingCap` for an agent or a chain (Plan 4 Task 5): the two kinds of budget are one monthly total, so a chain's change is held to the same effective
 * total, at the same counter version, and asks the admin with the same `owner_cap` request, with its own words ("agent and chain budgets") and its own scope.
 */
export async function holdingOwnerCap<T>(
  deps: AgentRouteDependencies, caller: AgentCaller, subject: { kind: "agent"; agentId: AgentId } | { kind: "chain"; chainId: ChainId },
  before: Parameters<typeof ownerShare>[0], after: Parameters<typeof ownerShare>[0],
  change: OwnerCapChange, mark: RequestMark, run: (options: { ownerCap: OwnerCap }) => Promise<T>,
): Promise<T | StatusReply> {
  const shares = () => ownerCapCheck(deps, caller.orgId, subject, before, after);
  const ask = async (over: { owner: string; wouldBeUsd: number; capUsd: number; ownerFinancialTerms?: OwnerFinancialTerms }): Promise<StatusReply> => {
    const newOwner = change.op === "set_owner" ? (change.owner.kind === "member" ? change.owner.developerId : change.accountable?.developerId) : change.op === "set_accountable" ? change.accountable.developerId : undefined;
    const monthly = ownerShare(after)?.usd || undefined; // a $0 base has no new limit to name
    const { record, message } = await requestOwnerCap(deps, {
      orgId: caller.orgId, ...(subject.kind === "agent" ? { agentId: subject.agentId } : { chainId: subject.chainId }), requestedBy: caller.developerId, owner: over.owner, wouldBeUsd: over.wouldBeUsd, capUsd: over.capUsd, ownerFinancialTerms: over.ownerFinancialTerms, change, request: mark, before,
      ...(monthly === undefined ? {} : { newLimitUsd: monthly }), ...(newOwner === undefined ? {} : { newOwner }),
    });
    return new StatusReply(202, { status: "NEEDS_ADMIN_APPROVAL", spendRequestId: record.spendRequestId, message });
  };
  const answer = await shares();
  if ("over" in answer) return ask(answer.over);
  try {
    return await run({ ownerCap: answer.ownerCap });
  } catch (error) {
    if (isOwnerCapRefusal(error) === undefined) throw error;
    // The total moved after the read (a raise, a top-up): over the cap now asks an admin; still within it (only the version moved) is written once more.
    const now = await shares();
    if ("over" in now) return ask(now.over);
    return run({ ownerCap: now.ownerCap });
  }
}

/** A request whose first answer was a 202 (it waits for an org admin) answers 202 again (R18). */
export const waitingReplay = (result: unknown): StatusReply | undefined =>
  (typeof result === "object" && result !== null && (result as { status?: unknown }).status === "NEEDS_ADMIN_APPROVAL" ? new StatusReply(202, result) : undefined);

async function projectAiView(deps: AgentRouteDependencies, orgId: OrgId, stored: { settings: ProjectAiSettings; revision: number }): Promise<Shown> {
  const orgOrder = deps.orgSourceOrder === undefined ? defaultModelSourceOrder(false) : await deps.orgSourceOrder(orgId);
  const policy = await readSpendPolicy(deps, orgId);
  return {
    settings: stored.settings,
    revision: stored.revision,
    effective: {
      sourceOrder: projectSourceOrder(stored.settings, orgOrder), planningLimitUsd: { QUICK: planningLimit(stored.settings, "QUICK"), FULL: planningLimit(stored.settings, "FULL") },
      // What a member can accept now, as the acceptance applies it: the setting or the lead threshold, held to the admin threshold.
      memberAcceptRunLimitUpToUsd: memberAcceptRunLimitUsd(stored.settings, policy),
    },
  };
}

async function getProjectAi(deps: AgentRouteDependencies, caller: AgentCaller, project: string): Promise<Shown> {
  await roleOnProject(deps, caller, project);
  return projectAiView(deps, caller.orgId, await readProjectAiWithRevision(deps, caller.orgId, project));
}

async function putProjectAiSettings(deps: AgentRouteDependencies, caller: AgentCaller, project: string, body: unknown): Promise<Shown> {
  const admin = isOrgAdmin(caller);
  const input = parseBody(ProjectAiBodySchema, body);
  const { requestId: _requestId, ...change } = input; // eslint-disable-line @typescript-eslint/no-unused-vars -- the id is the request's, not a setting
  if (Object.keys(change).length === 0) throw agentXError("CONFIG_INVALID", "body: name at least one of monthlyBudgetUsd, projectPays, sourceOrder, planningLimitUsd and memberAcceptRunLimitUpToUsd");
  // Owner decision 3: a project maintainer may change what a member can accept as a run limit, and nothing else of the project's AI settings.
  const acceptOnly = Object.keys(change).every((field) => field === "memberAcceptRunLimitUpToUsd");
  if (!admin && !acceptOnly) throw agentXError("FORBIDDEN", "Only an org owner or admin can change a project's AI settings.");
  const role = await roleOnProject(deps, caller, project);
  if (!admin && role !== "maintainer") throw agentXError("FORBIDDEN", "Only a project maintainer, or an org owner or admin, can change what a member may accept as a run limit.");
  const { mark, replay } = await markRequest(deps, caller, "project-ai", project, input);
  if (replay !== undefined) return projectAiView(deps, caller.orgId, replay.result as { settings: ProjectAiSettings; revision: number });
  const current = await readProjectAiWithRevision(deps, caller.orgId, project);
  const next = applyProjectAiChange(current.settings, change as ProjectAiChange);
  // Fix wave re-check N-1 (owner ruling): a member's allowance is never more than what a project maintainer may accept, the admin threshold; above it an org admin accepts.
  if (next.memberAcceptRunLimitUpToUsd !== undefined && next.memberAcceptRunLimitUpToUsd !== current.settings.memberAcceptRunLimitUpToUsd) {
    const adminThresholdUsd = (await readSpendPolicy(deps, caller.orgId)).adminApprovalThresholdUsd;
    if (next.memberAcceptRunLimitUpToUsd > adminThresholdUsd) {
      throw agentXError("CONFIG_INVALID", `memberAcceptRunLimitUpToUsd: can't be more than $${String(adminThresholdUsd)}, the amount above which your company needs an org admin's approval for a run limit`);
    }
  }
  await requireWithinTrial(deps, caller.orgId, "monthlyBudgetUsd", next.monthlyBudgetUsd, TRIAL_LIMITS_R49.projectMonthlyUsd, "project budget");
  if (next.sourceOrder !== undefined) {
    const allowed = new Set(deps.orgSourceOrder === undefined ? defaultModelSourceOrder(false) : await deps.orgSourceOrder(caller.orgId));
    const unknown = next.sourceOrder.find((source) => !allowed.has(source));
    if (unknown !== undefined) throw agentXError("CONFIG_INVALID", `sourceOrder: ${unknown} is not one of your company's model sources`);
  }
  const written = await writeProjectAi(deps, caller.orgId, project, next, caller.developerId, { actor: { developerId: caller.developerId, role: caller.orgRole }, expectedRevision: current.revision, request: mark, before: current.settings });
  return projectAiView(deps, caller.orgId, written);
}

async function putAgentBudget(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown | StatusReply> {
  const input = parseBody(BudgetBodySchema, body);
  // `manage` on a built-in is held by org owners and admins only.
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "manage");
  if (input.maxPerRunUsd !== undefined && input.maxPerRunUsd !== null && usdToWholeMicrodollars(input.maxPerRunUsd) === undefined) {
    throw agentXError("CONFIG_INVALID", "maxPerRunUsd: must be a number from 0 to 1000000 with at most 6 decimal places");
  }
  const { mark, replay } = await markRequest(deps, caller, "budget", agentId, input);
  const shown = (written: AgentRecord | BuiltinSettings): Promise<Shown> | Shown => ("owner" in written ? customView(written, access) : view(deps, caller, { agentId: agentId as BuiltinAgentId }, access, undefined, written));
  if (replay !== undefined) return waitingReplay(replay.result) ?? { agent: await shown(replay.result as AgentRecord | BuiltinSettings) };
  if (input.monthlyUsd === undefined && input.maxPerRunUsd === undefined) throw agentXError("CONFIG_INVALID", "body: name at least one of monthlyUsd and maxPerRunUsd");
  // Task 8 stored the guardrails' ceilings; this is where they hold (and again when an admin approves it over the owner cap).
  await requireAgentBudgetAllowed(deps, caller.orgId, input);
  const current: AgentRecord | BuiltinSettings = "owner" in agent ? agent : await deps.store.builtinBudgetSnapshot(caller.orgId, agentId, caller.developerId);
  const monthlyBudgetUsd = typeof input.monthlyUsd === "number" ? input.monthlyUsd : input.monthlyUsd === null ? undefined : current.monthlyBudgetUsd;
  const change = { ...(input.monthlyUsd === undefined ? {} : { monthlyUsd: input.monthlyUsd }), ...(input.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: input.maxPerRunUsd }) };
  const snapshot = input.maxPerRunUsd === undefined ? {} : { expectedMaxPerRunUsd: current.maxPerRunUsd ?? null };
  const written = await holdingCap(deps, caller, agentId, current, withBudgetFields(current, { monthlyBudgetUsd }), { op: "set_budget", budget: change, ...snapshot }, mark, (options) => deps.store.setBudget(caller.orgId, agentId, change, caller.developerId, mark, { ...options, ...snapshot, manageSnapshot: current, actor: { developerId: caller.developerId, role: caller.orgRole } }));
  if (written instanceof StatusReply) return written;
  return withDisabled({ agent: await shown(written) }, await recheck(deps, caller.orgId, agentId));
}

const SPEND_POLICY_PATH = "/v1/app/org/spend-policy";

function requireOrgAdmin(caller: AgentCaller): void {
  if (!isOrgAdmin(caller)) throw agentXError("FORBIDDEN", "Only an org owner or admin can see or change the company's spend policy.");
}

async function putSpendPolicy(deps: AgentRouteDependencies, caller: AgentCaller, body: unknown): Promise<Shown> {
  requireOrgAdmin(caller);
  const input = parseBody(SpendPolicyBodySchema, body);
  const { requestId: _requestId, ...change } = input; // eslint-disable-line @typescript-eslint/no-unused-vars -- the id is the request's, not a setting
  if (Object.keys(change).length === 0) throw agentXError("CONFIG_INVALID", "body: name at least one setting of the spend policy");
  const { mark, replay } = await markRequest(deps, caller, "spend-policy", "", input);
  if (replay !== undefined) return replay.result as Shown;
  const current = await readSpendPolicyWithRevision(deps, caller.orgId);
  const merged = SpendPolicySchema.safeParse({ ...current.policy, ...change });
  if (!merged.success) {
    const issue = merged.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "is not valid"}`);
  }
  await requireWithinTrial(deps, caller.orgId, "ownerAgentBudgetCapUsd", change.ownerAgentBudgetCapUsd, TRIAL_LIMITS_R49.ownerAgentBudgetCapUsd, "cap on one person's agent budgets");
  return { ...await writeSpendPolicy(deps, caller.orgId, merged.data, caller.developerId, { actor: { developerId: caller.developerId, role: caller.orgRole }, expectedRevision: current.revision, request: mark, before: current.policy }) };
}

// ---- routing

const PROJECT_AI_PATH = /^\/v1\/app\/projects\/([^/]+)\/ai$/;
const PROJECT_AGENTS_PATH = /^\/v1\/app\/projects\/([^/]+)\/agents(?:\/([^/]+))?$/;
const SKILL_PATH = /^\/v1\/app\/skills(?:\/([^/]+)(?:\/(content))?)?$/;
const AGENT_PATH = /^\/v1\/app\/agents(?:\/([^/]+)(?:\/([a-z-]+)(?:\/([0-9]{1,6}))?)?)?$/;

export function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

/**
 * `routeAgentRequest(deps, caller, request, url)`: the agent routes. A path under Plan 3's prefixes that no task has built yet
 * answers 404 `"that isn't available yet"`, so it is not mistaken for a route Plan 2 owns.
 */
export async function routeAgentRequest(deps: AgentRouteDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  // Task 30: the spend reads (`/v1/app/budget`, the org's spend and ledger, a project's and an agent's), before the agent paths they would otherwise match.
  const spend = await routeSpendRequest(deps, caller, request, url);
  if (spend !== undefined) return spend;
  // Task 21: the approvals (`/v1/app/approvals*`).
  if (isApprovalRoute(url.pathname)) return routeApprovalRequest(deps, caller, request, url);
  // Agent publish requests and the Home row's favourite and suggested agents (experience decisions 23 and 24), before the agent paths they would otherwise match.
  if (PUBLISH_REQUESTS_PATH.test(url.pathname)) return routePublishRequests(deps, caller, request, url);
  if (isMyAgentsRoute(url.pathname)) return routeMyAgents(deps, caller, request, url);
  // Task 32: the spend requests (`/v1/app/spend-requests*`) and a test run's continue-as-task.
  if (isSpendRequestRoute(url.pathname)) return routeSpendRequests(deps, caller, request, url);
  if (isConnectionRoute(url.pathname)) {
    if (deps.connections === undefined) throw agentXError("NOT_FOUND", "connections are not set up in this deployment");
    return routeConnectionRequest({ store: deps.connections, documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.brokerRoleArn === undefined ? {} : { brokerRoleArn: deps.brokerRoleArn }) }, caller, request, url);
  }
  // Lane E (Enterprise): the org's MCP servers.
  if (MCP_SERVERS_PATH.test(url.pathname)) {
    if (deps.mcpServers === undefined) throw agentXError("NOT_FOUND", "MCP servers are not set up in this deployment");
    return routeMcpServers(deps.mcpServers, caller, request, url);
  }
  // Lane E: the Sources settings of a project; matched before the generic project routes below.
  if (CONTEXT_SOURCES_PATH.test(url.pathname)) {
    if (deps.contextSources === undefined) throw agentXError("NOT_FOUND", "context sources are not set up in this deployment");
    return routeContextSources(deps.contextSources, caller, request, url);
  }
  // Task 14b's `…/connectors/github/comment-triggers` is matched before Task 13's project connectors, which would otherwise take every `…/connectors/…` path (PF24).
  const commentTriggers = COMMENT_TRIGGERS_PATH.exec(url.pathname);
  if (commentTriggers !== null) return routeCommentTriggers(deps, caller, request, url, commentTriggers[1]!);
  // Task 13: a project's connectors.
  if (isProjectConnectorRoute(url.pathname)) return routeProjectConnectorRequest(deps, caller, request, url);
  // Task 24b: the company AI sources (`/v1/app/org/model-sources*`).
  const modelSources = await routeModelSourceRequest(deps, caller, request, url);
  if (modelSources !== undefined) return modelSources;
  if (url.pathname === GUARDRAILS_PATH) {
    // The opt-outs of the comment rule are listed with the guardrails (Task 14b); they are read now, with the document.
    if (request.method === "GET") return { ...await readGuardrailsWithRevision(deps, caller.orgId), commentTriggerOptOuts: await listOptOutViews(deps, caller.orgId) };
    if (request.method === "PUT") return putGuardrails(deps, caller, jsonBody(request));
    throw agentXError("NOT_FOUND", "route not found");
  }
  if (url.pathname === SPEND_POLICY_PATH) {
    if (request.method === "GET") {
      requireOrgAdmin(caller);
      return readSpendPolicyWithRevision(deps, caller.orgId);
    }
    if (request.method === "PUT") return putSpendPolicy(deps, caller, jsonBody(request));
    throw agentXError("NOT_FOUND", "route not found");
  }
  const projectAi = PROJECT_AI_PATH.exec(url.pathname);
  if (projectAi !== null) {
    let project: string;
    try { project = decodeURIComponent(projectAi[1]!); } catch { throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name"); }
    if (request.method === "GET") return getProjectAi(deps, caller, project);
    if (request.method === "PUT") return putProjectAiSettings(deps, caller, project, jsonBody(request));
    throw agentXError("NOT_FOUND", "route not found");
  }
  const projectAgents = PROJECT_AGENTS_PATH.exec(url.pathname);
  if (projectAgents !== null) {
    let project: string;
    try { project = decodeURIComponent(projectAgents[1]!); } catch { throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name"); }
    const rawId = projectAgents[2];
    if (rawId === undefined) {
      if (request.method === "GET") return getRoster(deps, caller, project);
    } else if (request.method === "PUT") {
      return putRosterAgent(deps, caller, project, agentIdOf(rawId), jsonBody(request));
    } else if (request.method === "DELETE") {
      return deleteRosterAgent(deps, caller, project, agentIdOf(rawId), jsonBody(request));
    }
    throw agentXError("NOT_FOUND", "route not found");
  }
  // Plan 4 Task 18: the switch for the triggers built-in agents suggest, and the triggers of an agent.
  const builtinTriggers = await routeBuiltinTriggers(deps, caller, request, url);
  if (builtinTriggers !== undefined) return builtinTriggers;
  const agentTriggers = await routeAgentTriggers(deps, caller, request, url);
  if (agentTriggers !== undefined) return agentTriggers;
  // Plan 4 Task 19: the hooks vendors post a project's events to.
  const eventHooks = await routeEventHooks(deps, caller, request, url);
  if (eventHooks !== undefined) return eventHooks;
  const skillPath = SKILL_PATH.exec(url.pathname);
  if (skillPath !== null) {
    const [, skillId, sub] = skillPath;
    if (skillId === undefined) {
      if (request.method === "GET") return { skills: (await deps.store.skills.list(caller.orgId)).map(skillView) };
      if (request.method === "POST") return createSkill(deps, caller, jsonBody(request));
    } else if (sub === undefined) {
      if (request.method === "GET") return getSkill(deps, caller, skillId);
    } else if (request.method === "PUT") {
      return putSkillContent(deps, caller, skillId, jsonBody(request));
    }
    throw agentXError("NOT_FOUND", "route not found");
  }
  const matched = AGENT_PATH.exec(url.pathname);
  if (matched === null) throw agentXError("NOT_FOUND", "that isn't available yet");
  const [, rawId, sub, rawVersion] = matched;
  const method = request.method;
  if (rawId === undefined) {
    if (method === "GET") return listAgents(deps, caller, url);
    if (method === "POST") return createAgent(deps, caller, jsonBody(request));
    throw agentXError("NOT_FOUND", "route not found");
  }
  const agentId = agentIdOf(rawId);
  if (sub === undefined) {
    if (method === "GET") return getAgent(deps, caller, agentId);
    if (method === "PATCH") return patchAgent(deps, caller, agentId, jsonBody(request));
  } else if (rawVersion !== undefined) {
    if (sub === "versions" && method === "GET") return getVersion(deps, caller, agentId, Number(rawVersion));
  } else {
    const body = () => jsonBody(request);
    if (sub === "draft" && method === "GET") return getDraft(deps, caller, agentId);
    if (sub === "draft" && method === "PUT") return putDraft(deps, caller, agentId, body());
    if (sub === "publish" && method === "POST") return publishAgent(deps, caller, agentId, body());
    if (sub === "versions" && method === "GET") return listVersions(deps, caller, agentId);
    if (sub === "diff" && method === "GET") return diffAgent(deps, caller, agentId, url);
    if (sub === "rollback" && method === "POST") return rollback(deps, caller, agentId, body());
    if (sub === "archive" && method === "POST") return setArchived(deps, caller, agentId, body(), true);
    if (sub === "unarchive" && method === "POST") return setArchived(deps, caller, agentId, body(), false);
    if (sub === "shares" && method === "GET") return getShares(deps, caller, agentId);
    if (sub === "shares" && method === "PUT") return putShares(deps, caller, agentId, body());
    if (sub === "owner" && method === "PUT") return putOwner(deps, caller, agentId, body());
    if (sub === "accountable" && method === "PUT") return putAccountable(deps, caller, agentId, body());
    if (sub === "budget" && method === "PUT") return putAgentBudget(deps, caller, agentId, body());
    if (sub === "update-base" && method === "POST") return updateBase(deps, caller, agentId, body());
    if (sub === "adopt" && method === "POST") return adopt(deps, caller, agentId, body());
    if (sub === "runs" && method === "POST") return startRun(deps, caller, agentId, body(), request.headers);
    if (sub === "publish-requests") return routeAgentPublishRequests(deps, caller, request, agentId, url);
  }
  throw agentXError("NOT_FOUND", "route not found");
}

registerAgentApprovals();
registerRunVersionApproval();
registerProjectConnectorApprovals();
registerCommentTriggerApprovals();
registerPublicationApprovals();
