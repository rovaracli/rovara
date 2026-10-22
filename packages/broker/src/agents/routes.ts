// Plan 3 Task 7: the app's routes to build, version, publish, share and update agents (`/v1/app/agents*`). Every body is strict and
// carries a `requestId` (R18). Each route checks access first, with `requireAgentAccess`: an agent the caller can't see answers the
// same 404 as one that doesn't exist. A change that decides which recipe runs and makes anything less safe answers
// `202 { status: "NEEDS_CONFIRMATION", confirmUrl, changes }` and changes nothing until a person confirms it on the page (changes.ts).
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AgentGuardrailsSchema,
  AgentIdSchema,
  AgentOwnerSchema,
  AgentXNameSchema,
  BUILTIN_AGENTS,
  DEFAULT_RUN_ESTIMATE_USD,
  ModelSourceIdSchema,
  RUN_LIMIT_MULTIPLIER,
  RecipeOverlaySchema,
  RunInputSchema,
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
  projectAllows,
  recipeRunner,
  type AgentAccessLevel,
  type AgentId,
  type AgentOwner,
  type BaseRef,
  type BuiltinAgentId,
  type OrgId,
  type ProjectAiSettings,
  type ResolvedRecipe,
  type RunInput,
} from "@agentx/contracts";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import {
  agentAccess,
  listVisibleAgents,
  orgRoleOf,
  requireAgentAccess,
  requireOwnerAllowed,
  resolveSurvivor,
  type AccessibleAgent,
  type AgentCaller,
  type AgentScope,
} from "./access.js";
import { isApprovalRoute, routeApprovalRequest } from "./approval-routes.js";
import { COMMENT_TRIGGERS_PATH, routeCommentTriggers } from "./comment-trigger-routes.js";
import { listOptOutViews, registerCommentTriggerApprovals } from "./comment-trigger-optouts.js";
import { adoptBuiltin, publishDraft, registerAgentApprovals, resolveBase, resolveRecipe, rollbackAgent, shareAgent, updateGuardrails, type ChangeResult } from "./changes.js";
import type { ApprovalDependencies } from "./approvals.js";
import { readGuardrails, readGuardrailsWithRevision, requireBaseEnabled } from "./guardrails.js";
import { lessSafeChanges } from "./less-safe.js";
import type { PullRequestHeadReader } from "./runs.js";
import { addToRoster, checkRosterChange, listRoster, removeFromRoster, roleOnProject, rosterAgentView, type RosterEntry } from "./roster.js";
import type { SkillRecord } from "./skills.js";
import type { OrgStore } from "../org/store.js";
import { ownerShare, withBudgetFields } from "../spend/owner-total.js";
import { routeSpendRequest } from "../spend/routes.js";
import { isConnectionRoute, routeConnectionRequest, type ConnectionRouteDependencies } from "../connections/routes.js";
import { isProjectConnectorRoute, registerProjectConnectorApprovals, routeProjectConnectorRequest } from "../connections/project-connectors.js";
import { routeModelSourceRequest, type ModelSourceRouteDependencies } from "../model-sources/routes.js";
import {
  applyProjectAiChange, ownerBudgetRefusal, planningLimit, projectSourceOrder, readProjectAiWithRevision, readSpendPolicyWithRevision,
  writeProjectAi, writeSpendPolicy, type ProjectAiChange,
} from "../spend/settings.js";
import { isOwnerCapRefusal, updateAvailable, type AgentDraft, type AgentRecord, type AgentVersion, type BuiltinSettings, type OwnerCap, type RequestMark } from "./store.js";

/** What every agent route needs: the store, access, the approvals core and where the confirmation page lives. */
export interface AgentRouteDependencies extends ApprovalDependencies {
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
  /** Task 12b: the org's connections (`/v1/app/connections*`). Without it (no connection secrets role) those routes answer NOT_FOUND. */
  connections?: ConnectionRouteDependencies["store"];
  /** Plan 4 Task 16: the broker function's role ARN, for the trust policy a CloudWatch connection shows. */
  brokerRoleArn?: string;
  /** Starts a person's run (Task 15). The developer API supplies it, since it holds the task start; without it the route answers NOT_FOUND. */
  startRun?: (caller: AgentCaller, input: { requestId: string; project: string; agent: { agentId: AgentId; version?: number | "draft" }; input: RunInput }) => Promise<{ task: unknown }>;
}

/**
 * `POST /v1/app/agents/{id}/runs` [`use`]: a person starts a run of the agent on a project. Access to the project, to the agent, the roster and the
 * guardrails are checked by the start itself, before anything is charged (an agent the caller can't see answers the same 404 as one that doesn't exist).
 */
async function startRun(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<StatusReply> {
  if (deps.startRun === undefined) throw agentXError("NOT_FOUND", "starting runs is not set up in this deployment");
  const input = parseBody(RunBodySchema, body);
  const started = await deps.startRun(caller, {
    requestId: input.requestId, project: input.project, input: input.input,
    agent: { agentId, ...(input.version === undefined ? {} : { version: input.version }) },
  });
  return new StatusReply(202, { task: started.task });
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
  return /^\/v1\/app\/(agents|skills|approvals|spend-requests|connections|budget)(\/|$)/.test(pathname)
    || /^\/v1\/app\/org\/(agent-guardrails|model-sources|model-sources-order|spend|spend-policy)(\/|$)/.test(pathname)
    || /^\/v1\/app\/tasks\/[^/]+\/continue-as-task$/.test(pathname)
    || /^\/v1\/app\/projects\/[^/]+\/(agents|ai|spend|connectors)(\/|$)/.test(pathname);
}

// ---- bodies

const RequestIdSchema = z.string().uuid();
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const DeveloperRefSchema = z.object({ developerId: Hex64 }).strict();
const NoteSchema = z.string().trim().min(1).max(200);

const CreateBodySchema = z.object({
  requestId: RequestIdSchema,
  name: z.string(),
  description: z.string().optional(),
  owner: AgentOwnerSchema.optional(),
  accountable: DeveloperRefSchema.optional(),
  extends: AgentIdSchema.optional(),
  overlay: RecipeOverlaySchema.optional(),
}).strict();
const PatchBodySchema = z.object({ requestId: RequestIdSchema, name: z.string().optional(), description: z.string().optional() }).strict();
const PutDraftBodySchema = z.object({
  requestId: RequestIdSchema,
  expectedRevision: z.number().int().min(1),
  overlay: RecipeOverlaySchema,
  extends: AgentIdSchema.nullable().optional(),
}).strict();
const PublishBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: z.number().int().min(1), note: NoteSchema.optional() }).strict();
const RollbackBodySchema = z.object({ requestId: RequestIdSchema, version: z.number().int().min(1) }).strict();
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
}).strict();
const BudgetBodySchema = z.object({ requestId: RequestIdSchema, monthlyUsd: Amount.nullable().optional(), maxPerRunUsd: Amount.nullable().optional() }).strict();
const SpendPolicyBodySchema = SpendPolicyFieldsSchema.partial().extend({ requestId: RequestIdSchema }).strict();
const RunBodySchema = z.object({
  requestId: RequestIdSchema,
  project: z.string().min(1).max(200),
  version: z.union([z.number().int().min(1), z.literal("draft")]).optional(),
  input: RunInputSchema,
}).strict();
const GuardrailsBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: z.number().int().min(0), guardrails: AgentGuardrailsSchema }).strict();

function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue?.message ?? "is not valid"}`);
}

const notFound = () => agentXError("NOT_FOUND", "no agent has that ID");

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

async function builtinView(deps: AgentRouteDependencies, orgId: OrgId, agentId: AgentId, access: AgentAccessLevel, disabled: boolean, stored?: BuiltinSettings): Promise<Shown> {
  const template = BUILTIN_AGENTS[agentId as keyof typeof BUILTIN_AGENTS];
  const settings = stored ?? await deps.store.getBuiltinSettings(orgId, agentId);
  return {
    agentId,
    name: template.name,
    description: template.description,
    builtin: true,
    status: "active",
    ...(disabled ? { disabled: true } : {}),
    pinnedVersion: settings?.pinnedVersion ?? deps.store.builtinLatestVersion(agentId),
    latestVersion: deps.store.builtinLatestVersion(agentId),
    ...(template.needsLaterConnectors === undefined ? {} : { needsLaterConnectors: template.needsLaterConnectors }),
    ...(settings?.accountable === undefined ? {} : { accountable: settings.accountable }),
    ...(settings?.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: settings.monthlyBudgetUsd }),
    ...(settings?.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: settings.maxPerRunUsd }),
    access,
  };
}

async function view(deps: AgentRouteDependencies, caller: AgentCaller, agent: AccessibleAgent, access?: AgentAccessLevel, disabled?: boolean, settings?: BuiltinSettings): Promise<Shown> {
  const level = access ?? await agentAccess(deps, caller, agent);
  if ("owner" in agent) return customView(agent, level);
  return builtinView(deps, caller.orgId, agent.agentId, level, disabled ?? (await readGuardrails(deps, caller.orgId)).disabledBuiltins.some((id) => id === agent.agentId), settings);
}

/** The most one run of an agent may be limited to by default, shown beside the agent. Display only. */
function suggestedMaxPerRunUsd(recipe: ResolvedRecipe | undefined): number {
  const path = recipe !== undefined && recipeRunner(recipe) === "coding" ? DEFAULT_RUN_ESTIMATE_USD.FULL : DEFAULT_RUN_ESTIMATE_USD.AGENT;
  return path.highUsd * RUN_LIMIT_MULTIPLIER;
}

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
      Object.assign(summary, extendsRef === undefined ? {} : { extends: extendsRef }, update === undefined ? {} : { updateAvailable: update });
    }
    agents.push(summary);
  }
  return { agents };
}

async function getAgent(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId): Promise<Shown> {
  const { agent, access } = await requireReadableAgent(deps, caller, agentId, "view");
  const shown = await view(deps, caller, agent, access);
  if (!("owner" in agent)) {
    const version = shown["pinnedVersion"] as number;
    const recipe = deps.store.builtinRecipe(agentId, version);
    return { agent: shown, current: { version, recipe, changed: false }, suggestedMaxPerRunUsd: suggestedMaxPerRunUsd(recipe), ...(shown["maxPerRunUsd"] === undefined ? {} : { maxPerRunUsd: shown["maxPerRunUsd"] }) };
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
    suggestedMaxPerRunUsd: suggestedMaxPerRunUsd(current),
    ...(agent.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: agent.maxPerRunUsd }),
  };
}

async function listVersions(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId): Promise<{ versions: Shown[] }> {
  const { agent } = await requireReadableAgent(deps, caller, agentId, "view");
  if (!("owner" in agent)) {
    const pinned = (await deps.store.getBuiltinSettings(caller.orgId, agentId))?.pinnedVersion ?? deps.store.builtinLatestVersion(agentId);
    const releases = BUILTIN_AGENTS[agentId as keyof typeof BUILTIN_AGENTS].versions;
    return { versions: releases.map((release) => ({ version: release.version, digest: release.digest, releasedIn: release.releasedIn, notes: release.notes, current: release.version === pinned })) };
  }
  const versions = await deps.store.listVersions(caller.orgId, agentId);
  return {
    versions: versions.map((version) => ({
      version: version.version, name: version.name, description: version.description, digest: version.digest,
      publishedBy: version.publishedBy, publishedAt: version.publishedAt, ...(version.note === undefined ? {} : { note: version.note }),
      ...(version.extends === undefined ? {} : { extends: version.extends }), current: version.version === agent.currentVersion,
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
  return { version: { ...stored, current: stored.version === agent.currentVersion }, recipe: await resolveRecipe(deps, caller.orgId, agentId, version) };
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
  return { from, to, changes: diffRecipes(before, after), lessSafe: lessSafeChanges(before, after) };
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
async function markRequest(deps: AgentRouteDependencies, caller: AgentCaller, route: string, agentId: string, body: { requestId: string }): Promise<{ mark: RequestMark; replay?: { result: unknown } }> {
  const mark: RequestMark = { orgId: caller.orgId, developerId: caller.developerId, requestId: body.requestId, fingerprint: fingerprintOf(route, agentId, body) };
  const earlier = await deps.store.getRequest(caller.orgId, caller.developerId, body.requestId);
  if (earlier === undefined) return { mark };
  if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
  return { mark, replay: { result: earlier.result } };
}

// ---- writes

/** Someone who may answer for a project's agent: in the org, holding `manage_agents` on the project. Returned as the survivor of any merge. */
async function requireAccountable(deps: AgentRouteDependencies, orgId: OrgId, project: string, developerId: string): Promise<{ developerId: string }> {
  const survivor = await resolveSurvivor(deps, orgId, developerId);
  const orgRole = await orgRoleOf(deps, orgId, survivor);
  if (orgRole === undefined) throw agentXError("CONFIG_INVALID", "accountable: nobody in your company has that ID");
  const role = await deps.projectMembers.roleOf(orgId, project, { developerId: survivor, orgRole });
  if (role === undefined || !projectAllows(role, "manage_agents")) throw agentXError("CONFIG_INVALID", `accountable: that person needs to be a maintainer of ${project}`);
  return { developerId: survivor };
}

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
  return { draft };
}

async function putDraft(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(PutDraftBodySchema, body);
  await requireAgentAccess(deps, caller, agentId, "edit");
  const { mark, replay } = await markRequest(deps, caller, "draft", agentId, input);
  if (replay !== undefined) return { draft: replay.result as AgentDraft };
  // Building on another agent needs `use` on it; keeping the base it already has does not.
  if (typeof input.extends === "string" && input.extends !== (await deps.store.getDraft(caller.orgId, agentId))?.extends?.agentId) {
    await requireAgentAccess(deps, caller, input.extends, "use");
    await requireBaseEnabled(deps, caller.orgId, input.extends);
  }
  const draft = await deps.store.saveDraft({
    orgId: caller.orgId, agentId, overlay: input.overlay, expectedRevision: input.expectedRevision, by: caller.developerId, request: mark,
    ...(input.extends === undefined ? {} : { extends: input.extends }),
  });
  return { draft };
}

async function publishAgent(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<unknown> {
  const input = parseBody(PublishBodySchema, body);
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "edit");
  if (!("owner" in agent)) throw notFound();
  const { mark, replay } = await markRequest(deps, caller, "publish", agentId, input);
  if (replay !== undefined) return { version: replay.result as AgentVersion, agent: customView(await deps.store.get(caller.orgId, agentId) ?? agent, access) };
  const result = await publishDraft(deps, caller, agent, { ...input, request: mark });
  if (!result.applied) return waiting(result);
  return { version: result.value, agent: customView(await deps.store.get(caller.orgId, agentId) ?? agent, access) };
}

async function rollback(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<unknown> {
  const input = parseBody(RollbackBodySchema, body);
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "edit");
  if (!("owner" in agent)) throw notFound();
  const { mark, replay } = await markRequest(deps, caller, "rollback", agentId, input);
  if (replay !== undefined) return { agent: customView(replay.result as AgentRecord, access) };
  const result = await rollbackAgent(deps, caller, agent, { ...input, request: mark });
  return result.applied ? { agent: customView(result.value, access) } : waiting(result);
}

async function setArchived(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown, archive: boolean): Promise<Shown> {
  const input = parseBody(RequestOnlySchema, body);
  const { access } = await requireAgentAccess(deps, caller, agentId, "manage");
  const { mark, replay } = await markRequest(deps, caller, archive ? "archive" : "unarchive", agentId, input);
  if (replay !== undefined) return { agent: customView(replay.result as AgentRecord, access) };
  if (archive) return { agent: customView(await deps.store.archive(caller.orgId, agentId, caller.developerId, mark), access) };
  // Unarchiving puts the agent's budget back in its owner's total; an archived agent's budget counted for no one.
  const current = await deps.store.get(caller.orgId, agentId);
  const unarchived = current === undefined || current.status !== "archived"
    ? await deps.store.unarchive(caller.orgId, agentId, caller.developerId, mark)
    : await holdingCap(deps, caller, current, withBudgetFields(current, { status: "active" }), (options) => deps.store.unarchive(caller.orgId, agentId, caller.developerId, mark, options));
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

async function putOwner(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(OwnerBodySchema, body);
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "manage");
  if (!("owner" in agent)) throw agentXError("CONFIG_INVALID", `${deps.store.builtinName(agentId)} is built in and belongs to the whole company`);
  const { mark, replay } = await markRequest(deps, caller, "owner", agentId, input);
  if (replay !== undefined) return { agent: customView(replay.result as AgentRecord, access) };
  // Store the owner this returns, not the one asked for: a member who was merged into another is named by the survivor.
  const owner = await requireOwnerAllowed(deps, caller, input.owner, agent.owner);
  const accountable = input.accountable === undefined ? undefined : owner.kind === "project" ? await requireAccountable(deps, caller.orgId, owner.project, input.accountable.developerId) : input.accountable;
  // The agent's budget leaves its owner's total and joins the new owner's (the maintainer accountable for a project's agent).
  const { accountable: _before, ...kept } = agent; // eslint-disable-line @typescript-eslint/no-unused-vars -- the new owner decides it
  const updated = await holdingCap(deps, caller, agent, { ...kept, owner, ...(accountable === undefined ? {} : { accountable }) }, (options) => deps.store.setOwner(caller.orgId, agentId, owner, caller.developerId, accountable, mark, options));
  return { agent: customView(updated, access) };
}

async function putAccountable(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(AccountableBodySchema, body);
  const { agent } = await requireAgentAccess(deps, caller, agentId, "manage");
  const { mark, replay } = await markRequest(deps, caller, "accountable", agentId, input);
  if (replay !== undefined) return replay.result as Shown;
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
  const current = "owner" in agent ? agent : await deps.store.ensureBuiltinSettings(caller.orgId, agentId, caller.developerId);
  await holdingCap(deps, caller, current, withBudgetFields(current, { accountable }), (options) => deps.store.setAccountable(caller.orgId, agentId, accountable, caller.developerId, mark, options));
  return { accountable };
}

async function updateBase(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(UpdateBaseBodySchema, body);
  await requireAgentAccess(deps, caller, agentId, "edit");
  const { mark, replay } = await markRequest(deps, caller, "update-base", agentId, input);
  const answer = async (draft: AgentDraft, previous: BaseRef | undefined): Promise<Shown> => {
    const moved = previous !== undefined && draft.extends !== undefined && draft.extends.version !== previous.version;
    return { draft, changes: moved ? diffRecipes(await resolveBase(deps, caller.orgId, previous), await resolveBase(deps, caller.orgId, draft.extends)) : [] };
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
  return result.applied ? result.value : waiting(result);
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
  return result.applied ? result.value : waiting(result);
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
  return { removed: await removeFromRoster(deps, { orgId: caller.orgId, project, agentId, request: mark }) };
}

// ---- budgets (Task 28)

const isOrgAdmin = (caller: AgentCaller) => caller.orgRole === "owner" || caller.orgRole === "admin";

/** R49 (`TRIAL_LIMITS_R49`): a trial org stays within the placeholder limits until billing exists. Nothing is read of the org unless the amount is over the cap. */
async function requireWithinTrial(deps: AgentRouteDependencies, orgId: OrgId, label: string, amount: number | null | undefined, capUsd: number, what: string): Promise<void> {
  if (typeof amount !== "number" || amount <= capUsd) return;
  if ((await deps.orgs?.getOrg(orgId))?.plan !== "trial") return;
  throw agentXError("CONFIG_INVALID", `${label}: a trial organization's ${what} is at most $${String(capUsd)} a month; upgrade the plan to raise it`);
}

async function ownerName(deps: AgentRouteDependencies, developerId: string): Promise<string> {
  return (await deps.signInStore.getDeveloper(developerId))?.displayName ?? "That person";
}

/**
 * Runs a write that moves an agent's budget from `before` to `after`, held to the cap. It refuses first, in words, a change that would take
 * someone's agent budgets past `ownerAgentBudgetCapUsd` (owners read as their survivors, the way the store counts them). If the store
 * still refuses it for the cap (the total moved after this read), the refusal is put in the same words with the figures as they are now.
 * Task 32 turns the refusal into an `owner_cap` request (see `ownerBudgetRefusal`).
 */
async function holdingCap<T>(deps: AgentRouteDependencies, caller: AgentCaller, before: Parameters<typeof ownerShare>[0], after: Parameters<typeof ownerShare>[0], run: (options: { ownerCap: OwnerCap }) => Promise<T>): Promise<T> {
  const shares = async () => {
    const survivor = async (share: ReturnType<typeof ownerShare>) => (share === undefined ? undefined : { ...share, owner: await resolveSurvivor(deps, caller.orgId, share.owner) });
    return ownerBudgetRefusal(deps, caller.orgId, await survivor(ownerShare(before)), await survivor(ownerShare(after)), (developerId) => ownerName(deps, developerId));
  };
  const answer = await shares();
  if ("message" in answer) throw agentXError("CONFIG_INVALID", answer.message);
  try {
    return await run({ ownerCap: answer.ownerCap });
  } catch (error) {
    if (isOwnerCapRefusal(error) !== undefined) {
      const now = await shares();
      if ("message" in now) throw agentXError("CONFIG_INVALID", now.message);
    }
    throw error;
  }
}

async function projectAiView(deps: AgentRouteDependencies, orgId: OrgId, stored: { settings: ProjectAiSettings; revision: number }): Promise<Shown> {
  const orgOrder = deps.orgSourceOrder === undefined ? defaultModelSourceOrder(false) : await deps.orgSourceOrder(orgId);
  return {
    settings: stored.settings,
    revision: stored.revision,
    effective: { sourceOrder: projectSourceOrder(stored.settings, orgOrder), planningLimitUsd: { QUICK: planningLimit(stored.settings, "QUICK"), FULL: planningLimit(stored.settings, "FULL") } },
  };
}

async function getProjectAi(deps: AgentRouteDependencies, caller: AgentCaller, project: string): Promise<Shown> {
  await roleOnProject(deps, caller, project);
  return projectAiView(deps, caller.orgId, await readProjectAiWithRevision(deps, caller.orgId, project));
}

async function putProjectAiSettings(deps: AgentRouteDependencies, caller: AgentCaller, project: string, body: unknown): Promise<Shown> {
  if (!isOrgAdmin(caller)) throw agentXError("FORBIDDEN", "Only an org owner or admin can change a project's AI settings.");
  const input = parseBody(ProjectAiBodySchema, body);
  const { requestId: _requestId, ...change } = input; // eslint-disable-line @typescript-eslint/no-unused-vars -- the id is the request's, not a setting
  if (Object.keys(change).length === 0) throw agentXError("CONFIG_INVALID", "body: name at least one of monthlyBudgetUsd, projectPays, sourceOrder and planningLimitUsd");
  await roleOnProject(deps, caller, project);
  const { mark, replay } = await markRequest(deps, caller, "project-ai", project, input);
  if (replay !== undefined) return projectAiView(deps, caller.orgId, replay.result as { settings: ProjectAiSettings; revision: number });
  const current = await readProjectAiWithRevision(deps, caller.orgId, project);
  const next = applyProjectAiChange(current.settings, change as ProjectAiChange);
  await requireWithinTrial(deps, caller.orgId, "monthlyBudgetUsd", next.monthlyBudgetUsd, TRIAL_LIMITS_R49.projectMonthlyUsd, "project budget");
  if (next.sourceOrder !== undefined) {
    const allowed = new Set(deps.orgSourceOrder === undefined ? defaultModelSourceOrder(false) : await deps.orgSourceOrder(caller.orgId));
    const unknown = next.sourceOrder.find((source) => !allowed.has(source));
    if (unknown !== undefined) throw agentXError("CONFIG_INVALID", `sourceOrder: ${unknown} is not one of your company's model sources`);
  }
  const written = await writeProjectAi(deps, caller.orgId, project, next, caller.developerId, { expectedRevision: current.revision, request: mark, before: current.settings });
  return projectAiView(deps, caller.orgId, written);
}

async function putAgentBudget(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(BudgetBodySchema, body);
  // `manage` on a built-in is held by org owners and admins only.
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "manage");
  const { mark, replay } = await markRequest(deps, caller, "budget", agentId, input);
  const shown = (written: AgentRecord | BuiltinSettings): Promise<Shown> | Shown => ("owner" in written ? customView(written, access) : view(deps, caller, { agentId: agentId as BuiltinAgentId }, access, undefined, written));
  if (replay !== undefined) return { agent: await shown(replay.result as AgentRecord | BuiltinSettings) };
  if (input.monthlyUsd === undefined && input.maxPerRunUsd === undefined) throw agentXError("CONFIG_INVALID", "body: name at least one of monthlyUsd and maxPerRunUsd");
  // Task 8 stored the guardrails' ceilings; this is where they hold.
  const guardrails = await readGuardrails(deps, caller.orgId);
  if (typeof input.monthlyUsd === "number" && input.monthlyUsd > guardrails.maxAgentMonthlyUsd) {
    throw agentXError("CONFIG_INVALID", `monthlyUsd: your company's guardrails allow at most $${String(guardrails.maxAgentMonthlyUsd)} a month for one agent`);
  }
  if (typeof input.maxPerRunUsd === "number" && input.maxPerRunUsd > guardrails.maxPerRunCeilingUsd) {
    throw agentXError("CONFIG_INVALID", `maxPerRunUsd: your company's guardrails allow at most $${String(guardrails.maxPerRunCeilingUsd)} for one run`);
  }
  await requireWithinTrial(deps, caller.orgId, "monthlyUsd", input.monthlyUsd, TRIAL_LIMITS_R49.agentMonthlyUsd, "agent budget");
  const current: AgentRecord | BuiltinSettings = "owner" in agent ? agent : await deps.store.ensureBuiltinSettings(caller.orgId, agentId, caller.developerId);
  const monthlyBudgetUsd = typeof input.monthlyUsd === "number" ? input.monthlyUsd : input.monthlyUsd === null ? undefined : current.monthlyBudgetUsd;
  const change = { ...(input.monthlyUsd === undefined ? {} : { monthlyUsd: input.monthlyUsd }), ...(input.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: input.maxPerRunUsd }) };
  const written = await holdingCap(deps, caller, current, withBudgetFields(current, { monthlyBudgetUsd }), (options) => deps.store.setBudget(caller.orgId, agentId, change, caller.developerId, mark, options));
  return { agent: await shown(written) };
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
  return { ...await writeSpendPolicy(deps, caller.orgId, merged.data, caller.developerId, { expectedRevision: current.revision, request: mark, before: current.policy }) };
}

// ---- routing

const PROJECT_AI_PATH = /^\/v1\/app\/projects\/([^/]+)\/ai$/;
const PROJECT_AGENTS_PATH = /^\/v1\/app\/projects\/([^/]+)\/agents(?:\/([^/]+))?$/;
const SKILL_PATH = /^\/v1\/app\/skills(?:\/([^/]+)(?:\/(content))?)?$/;
const AGENT_PATH = /^\/v1\/app\/agents(?:\/([^/]+)(?:\/([a-z-]+)(?:\/([0-9]{1,6}))?)?)?$/;

function jsonBody(request: AdaptedHttpRequest): unknown {
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
  if (isConnectionRoute(url.pathname)) {
    if (deps.connections === undefined) throw agentXError("NOT_FOUND", "connections are not set up in this deployment");
    return routeConnectionRequest({ store: deps.connections, documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.brokerRoleArn === undefined ? {} : { brokerRoleArn: deps.brokerRoleArn }) }, caller, request, url);
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
    if (sub === "runs" && method === "POST") return startRun(deps, caller, agentId, body());
  }
  throw agentXError("NOT_FOUND", "route not found");
}

registerAgentApprovals();
registerProjectConnectorApprovals();
registerCommentTriggerApprovals();
