// Plan 3 Task 7: the app's routes to build, version, publish, share and update agents (`/v1/app/agents*`). Every body is strict and
// carries a `requestId` (R18). Each route checks access first, with `requireAgentAccess`: an agent the caller can't see answers the
// same 404 as one that doesn't exist. A change that decides which recipe runs and makes anything less safe answers
// `202 { status: "NEEDS_CONFIRMATION", confirmUrl, changes }` and changes nothing until a person confirms it on the page (changes.ts).
import { z } from "zod";
import {
  AgentIdSchema,
  AgentOwnerSchema,
  AgentXNameSchema,
  BUILTIN_AGENTS,
  DEFAULT_RUN_ESTIMATE_USD,
  RUN_LIMIT_MULTIPLIER,
  RecipeOverlaySchema,
  AgentXError,
  agentXError,
  atLeast,
  diffRecipes,
  isBuiltinAgentId,
  projectAllows,
  recipeRunner,
  type AgentAccessLevel,
  type AgentId,
  type AgentOwner,
  type OrgId,
  type ResolvedRecipe,
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
import { adoptBuiltin, publishDraft, registerAgentApprovals, resolveBase, resolveRecipe, rollbackAgent, shareAgent, type ChangeResult } from "./changes.js";
import type { ApprovalDependencies } from "./approvals.js";
import { lessSafeChanges } from "./less-safe.js";
import { updateAvailable, type AgentRecord } from "./store.js";

/** What every agent route needs: the store, access, the approvals core and where the confirmation page lives. */
export type AgentRouteDependencies = ApprovalDependencies;

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
    || /^\/v1\/app\/org\/(agent-guardrails|model-sources|spend)(\/|$)/.test(pathname)
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

function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue?.message ?? "is not valid"}`);
}

const notFound = () => agentXError("NOT_FOUND", "no agent has that ID");

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

async function builtinView(deps: AgentRouteDependencies, orgId: OrgId, agentId: AgentId, access: AgentAccessLevel): Promise<Shown> {
  const template = BUILTIN_AGENTS[agentId as keyof typeof BUILTIN_AGENTS];
  const settings = await deps.store.getBuiltinSettings(orgId, agentId);
  return {
    agentId,
    name: template.name,
    description: template.description,
    builtin: true,
    status: "active",
    pinnedVersion: settings?.pinnedVersion ?? deps.store.builtinLatestVersion(agentId),
    latestVersion: deps.store.builtinLatestVersion(agentId),
    ...(template.needsLaterConnectors === undefined ? {} : { needsLaterConnectors: template.needsLaterConnectors }),
    ...(settings?.accountable === undefined ? {} : { accountable: settings.accountable }),
    ...(settings?.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: settings.monthlyBudgetUsd }),
    ...(settings?.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: settings.maxPerRunUsd }),
    access,
  };
}

async function view(deps: AgentRouteDependencies, caller: AgentCaller, agent: AccessibleAgent, access?: AgentAccessLevel): Promise<Shown> {
  const level = access ?? await agentAccess(deps, caller, agent);
  return "owner" in agent ? customView(agent, level) : builtinView(deps, caller.orgId, agent.agentId, level);
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
    const summary = await view(deps, caller, visible.record ?? { agentId: visible.agentId } as AccessibleAgent, visible.access);
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
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "view");
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
  const { agent } = await requireAgentAccess(deps, caller, agentId, "view");
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
  const { agent } = await requireAgentAccess(deps, caller, agentId, "view");
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
  const { agent } = await requireAgentAccess(deps, caller, agentId, from === "draft" || to === "draft" ? "edit" : "view");
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
  const owner: AgentOwner = input.owner ?? { kind: "member", developerId: caller.developerId };
  const stored = await requireOwnerAllowed(deps, caller, owner);
  // A project's accountable maintainer must be able to manage its agents; a member's agent has none (the store refuses one).
  const accountable = input.accountable === undefined ? undefined : stored.kind === "project" ? await requireAccountable(deps, caller.orgId, stored.project, input.accountable.developerId) : input.accountable;
  if (input.extends !== undefined) await requireAgentAccess(deps, caller, input.extends, "use");
  const agent = await deps.store.create({
    orgId: caller.orgId, name: input.name, owner: stored, createdBy: caller.developerId,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(accountable === undefined ? {} : { accountable }),
    ...(input.extends === undefined ? {} : { extends: input.extends }),
    ...(input.overlay === undefined ? {} : { overlay: input.overlay }),
  });
  return new StatusReply(201, { agent: await view(deps, caller, agent) });
}

async function patchAgent(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(PatchBodySchema, body);
  if (input.name === undefined && input.description === undefined) throw agentXError("CONFIG_INVALID", "body: change a name or a description");
  const { access } = await requireAgentAccess(deps, caller, agentId, "edit");
  const agent = await deps.store.updateProfile({
    orgId: caller.orgId, agentId, by: caller.developerId,
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
  // Building on another agent needs `use` on it; keeping the base it already has does not.
  if (typeof input.extends === "string" && input.extends !== (await deps.store.getDraft(caller.orgId, agentId))?.extends?.agentId) {
    await requireAgentAccess(deps, caller, input.extends, "use");
  }
  const draft = await deps.store.saveDraft({
    orgId: caller.orgId, agentId, overlay: input.overlay, expectedRevision: input.expectedRevision, by: caller.developerId,
    ...(input.extends === undefined ? {} : { extends: input.extends }),
  });
  return { draft };
}

async function publishAgent(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<unknown> {
  const input = parseBody(PublishBodySchema, body);
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "edit");
  if (!("owner" in agent)) throw notFound();
  const result = await publishDraft(deps, caller, agent, input);
  if (!result.applied) return waiting(result);
  return { version: result.value, agent: customView(await deps.store.get(caller.orgId, agentId) ?? agent, access) };
}

async function rollback(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<unknown> {
  const input = parseBody(RollbackBodySchema, body);
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "edit");
  if (!("owner" in agent)) throw notFound();
  const result = await rollbackAgent(deps, caller, agent, input);
  return result.applied ? { agent: customView(result.value, access) } : waiting(result);
}

async function setArchived(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown, archive: boolean): Promise<Shown> {
  parseBody(RequestOnlySchema, body);
  const { access } = await requireAgentAccess(deps, caller, agentId, "manage");
  const agent = archive ? await deps.store.archive(caller.orgId, agentId, caller.developerId) : await deps.store.unarchive(caller.orgId, agentId, caller.developerId);
  return { agent: customView(agent, access) };
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
  const result = await shareAgent(deps, caller, agent, input);
  return result.applied ? { shares: result.value } : waiting(result);
}

async function putOwner(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(OwnerBodySchema, body);
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "manage");
  if (!("owner" in agent)) throw agentXError("CONFIG_INVALID", `${deps.store.builtinName(agentId)} is built in and belongs to the whole company`);
  // Store the owner this returns, not the one asked for: a member who was merged into another is named by the survivor.
  const owner = await requireOwnerAllowed(deps, caller, input.owner, agent.owner);
  const accountable = input.accountable === undefined ? undefined : owner.kind === "project" ? await requireAccountable(deps, caller.orgId, owner.project, input.accountable.developerId) : input.accountable;
  const updated = await deps.store.setOwner(caller.orgId, agentId, owner, caller.developerId, accountable);
  return { agent: customView(updated, access) };
}

async function putAccountable(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(AccountableBodySchema, body);
  const { agent } = await requireAgentAccess(deps, caller, agentId, "manage");
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
  await deps.store.setAccountable(caller.orgId, agentId, accountable, caller.developerId);
  return { accountable };
}

async function updateBase(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<Shown> {
  const input = parseBody(UpdateBaseBodySchema, body);
  await requireAgentAccess(deps, caller, agentId, "edit");
  const before = (await deps.store.getDraft(caller.orgId, agentId))?.extends;
  const draft = await deps.store.updateBase({ orgId: caller.orgId, agentId, expectedRevision: input.expectedRevision, by: caller.developerId });
  const moved = before !== undefined && draft.extends !== undefined && draft.extends.version !== before.version;
  const changes = moved ? diffRecipes(await resolveBase(deps, caller.orgId, before), await resolveBase(deps, caller.orgId, draft.extends)) : [];
  return { draft, changes };
}

async function adopt(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<unknown> {
  const input = parseBody(AdoptBodySchema, body);
  if (!isBuiltinAgentId(agentId)) throw agentXError("CONFIG_INVALID", "only a built-in agent has versions to adopt");
  // `manage` on a built-in is held by org owners and admins only.
  await requireAgentAccess(deps, caller, agentId, "manage");
  const result = await adoptBuiltin(deps, caller, agentId, input);
  return result.applied ? result.value : waiting(result);
}

// ---- routing

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
    if (sub === "update-base" && method === "POST") return updateBase(deps, caller, agentId, body());
    if (sub === "adopt" && method === "POST") return adopt(deps, caller, agentId, body());
  }
  throw agentXError("NOT_FOUND", "route not found");
}

registerAgentApprovals();
