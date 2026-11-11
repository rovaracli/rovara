// Plan 3 Task 10: which agents work on a project (its roster) and how the agent a run uses is chosen. A roster is one item per agent under
// the project (`PROJECT_AGENTS#<project>`); the built-ins are on every roster without an item. `resolveAgentForTask` is what a person's
// run goes through (access, then the roster, then the recipe against the company's guardrails as they stand now) and
// `resolveAgentForAutonomousRun` is the same without a person (H3). The routes that change a roster are in routes.ts, which owns the
// repeated-request marks; this file holds the checks, the storage and the views they use.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXNameSchema, BUILTIN_AGENTS, ROVARA_CODE_AGENT_ID, agentXError, atLeast, isBuiltinAgentId, orgProjectCatalogKey, projectAgentKey, projectAllows, recipeDigest, type AgentAccessLevel, type AgentId, type OrgId, type ProjectRole, type ResolvedRecipe, projectArchivedMessage } from "@rovara-code/contracts";
import { readProjectMeta, requireNewWorkAllowed } from "../developer/project-roles.js";
import { agentAccess, listVisibleAgents, requireAgentAccess, type AgentCaller } from "./access.js";
import type { ApprovalDependencies } from "./approvals.js";
import { resolveRecipe, versionSafety } from "./changes.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { auditedWrite, rosterAuditEvent } from "../playbook/project-settings-audit.js";
import { requireAgentEnabled, validateRecipeForOrg } from "./guardrails.js";
import { EXISTS, coded, commit, putNew, strip, type Item, type RequestMark, type TransactItem } from "./table-writes.js";
import type { AgentDraft, AgentRecord } from "./store.js";

/** What the roster and the run-start checks need: the agent routes' dependencies, and optionally Plan 2's project access check. */
export interface RosterDependencies extends ApprovalDependencies {
  /**
   * FR-018's access check for the caller on a project (`checkProjectAccess`, Plan 2 Task 8), for a start that did not make it first.
   * Without it the caller's role comes from `projectMembers`, and a caller with none is told the project isn't found.
   */
  checkProjectAccess?: (caller: AgentCaller, project: string) => Promise<{ role: ProjectRole }>;
}

/** The agent a run used, as the task record keeps it (the digest is of the whole resolved recipe, which the run freezes). */
export interface TaskAgentRef {
  agentId: AgentId;
  name: string;
  version: number | "draft";
  builtin: boolean;
  /** Set when the agent is a project's process layer ("How we work"): its tasks are Rovara Code tasks (`isRovaraCodeTask`). */
  process?: true;
  /** Only for a draft test run: the draft revision that was read. */
  draftRevision?: number;
  digest: string;
}

/** One agent on one project's roster, as stored. */
export interface RosterEntry {
  orgId: OrgId;
  project: string;
  agentId: AgentId;
  addedBy: string;
  addedAt: string;
}

/** An agent on a roster, as the list shows it. A built-in has no entry of its own, so no `addedBy`. */
export interface RosterAgentView {
  agentId: AgentId;
  name: string;
  description: string;
  builtin: boolean;
  status: "active" | "archived";
  access: AgentAccessLevel;
  currentVersion?: number;
  /** A built-in's version the company has pinned. */
  pinnedVersion?: number;
  /** A built-in the company turned off; only owners and admins are shown it. */
  disabled?: true;
  addedBy?: string;
  addedAt?: string;
}

const projectNotFound = (project: string) => agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);

// ---- the stored roster

async function readEntry(deps: RosterDependencies, orgId: OrgId, project: string, agentId: AgentId): Promise<RosterEntry | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectAgentKey(orgId, project, agentId), ConsistentRead: true })) as { Item?: Item };
  return response.Item === undefined ? undefined : (strip(response.Item) as unknown as RosterEntry);
}

/**
 * The agents on the project's roster, in the order of their ids: at most `max` of them when given. A roster longer than that is cut (the rest is not read) and `onCut` is called, so
 * that the caller can log it.
 */
async function readEntries(deps: RosterDependencies, orgId: OrgId, project: string, bound?: { max: number; onCut: () => void }): Promise<RosterEntry[]> {
  const found: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk",
      // Every entry's key shares this partition; the agent id is only the sort key.
      ExpressionAttributeValues: { ":pk": projectAgentKey(orgId, project, "").pk },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    found.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
    if (bound !== undefined && found.length >= bound.max && (start !== undefined || found.length > bound.max)) {
      bound.onCut();
      found.length = bound.max;
      break;
    }
  } while (start !== undefined);
  return found.map((item) => strip(item) as unknown as RosterEntry);
}

const rosterConflict = () => coded("AGENT_REVISION_CONFLICT", "Someone else changed which agents work on this project. Reload it and make your change again.");

/**
 * Puts the agent on the project's roster, in one transaction with the request's item (R18). An agent already there is left as it is, with
 * the person and time that put it there; only the request's item is written. Who may, and that the agent exists, are the caller's checks (`checkRosterChange`).
 */
export async function addToRoster(deps: RosterDependencies, input: { orgId: OrgId; project: string; agentId: AgentId; by: string; request?: RequestMark }): Promise<RosterEntry> {
  const existing = await readEntry(deps, input.orgId, input.project, input.agentId);
  if (existing !== undefined) {
    // Nothing to change, but the request is still remembered: a retry must not undo what someone did after it.
    if (input.request !== undefined) await commit(deps, [], () => undefined, input.request, existing);
    return existing;
  }
  const entry: RosterEntry = { orgId: input.orgId, project: input.project, agentId: input.agentId, addedBy: input.by, addedAt: new Date(deps.now()).toISOString() };
  const { orgId: _orgId, project: _project, agentId: _agentId, ...fields } = entry; // eslint-disable-line @typescript-eslint/no-unused-vars -- the key carries them; the item repeats them for reading
  const item = putNew(deps, projectAgentKey(input.orgId, input.project, input.agentId), "PROJECT_AGENT", { orgId: input.orgId, project: input.project, agentId: input.agentId, ...fields });
  const audit = await auditedWrite(deps, () => [rosterAuditEvent({ orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: entry.addedAt, project: input.project, agentId: input.agentId, change: "added", requestId: input.request?.requestId })]);
  await commit(deps, [item, ...audit.items], () => rosterConflict(), input.request, entry);
  await flushAuditEvents(deps, audit.events);
  return entry;
}

/** Takes the agent off the project's roster, in one transaction with the request's item. False when it was not on it (only the request's item is written). */
export async function removeFromRoster(deps: RosterDependencies, input: { orgId: OrgId; project: string; agentId: AgentId; by: string; request?: RequestMark }): Promise<boolean> {
  if (await readEntry(deps, input.orgId, input.project, input.agentId) === undefined) {
    if (input.request !== undefined) await commit(deps, [], () => undefined, input.request, { removed: false });
    return false;
  }
  const drop: TransactItem = { Delete: { TableName: deps.tableName, Key: projectAgentKey(input.orgId, input.project, input.agentId), ConditionExpression: EXISTS } };
  const audit = await auditedWrite(deps, () => [rosterAuditEvent({ orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: new Date(deps.now()).toISOString(), project: input.project, agentId: input.agentId, change: "removed", requestId: input.request?.requestId })]);
  await commit(deps, [drop, ...audit.items], () => rosterConflict(), input.request, { removed: true });
  await flushAuditEvents(deps, audit.events);
  return true;
}

// ---- who may see and change a roster

/** The caller's role on the project, from the project's members. Nothing is learned about a project the caller has no role on. */
export async function roleOnProject(deps: RosterDependencies, caller: AgentCaller, project: string): Promise<ProjectRole> {
  if (!AgentXNameSchema.safeParse(project).success) throw projectNotFound(project);
  const role = await deps.projectMembers.roleOf(caller.orgId, project, { developerId: caller.developerId, orgRole: caller.orgRole });
  if (role === undefined) throw projectNotFound(project);
  return role;
}

/**
 * Checks, in order, that a roster change may be made: the caller has a role on the project, holds `manage_agents` there, and the project
 * is not archived; and, when the change adds `agentId`, that the caller can `use` it, that it is a custom agent and not archived. Returns
 * the agent being added (undefined for a removal, which asks nothing of the agent: a maintainer can always take one off).
 */
export async function checkRosterChange(deps: RosterDependencies, caller: AgentCaller, project: string, change: { add: AgentId } | { remove: AgentId }): Promise<AgentRecord | undefined> {
  const role = await roleOnProject(deps, caller, project);
  if (!projectAllows(role, "manage_agents")) throw agentXError("FORBIDDEN", `Only a maintainer of ${project} can change which agents work on it.`);
  if ((await readProjectMeta(deps, caller.orgId, project))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(project));
  const agentId = "add" in change ? change.add : change.remove;
  if (isBuiltinAgentId(agentId)) throw agentXError("CONFIG_INVALID", "Built-in agents are on every project already.");
  if (!("add" in change)) return undefined;
  const { agent } = await requireAgentAccess(deps, caller, agentId, "use");
  if (!("owner" in agent) || agent.purpose === "process") throw agentXError("NOT_FOUND", "no agent has that ID");
  requireNotArchived(agent);
  return agent;
}

/** One roster entry as the caller sees it, or undefined when the agent is gone or the caller cannot at least view it. */
export async function rosterAgentView(deps: RosterDependencies, caller: AgentCaller, entry: RosterEntry): Promise<RosterAgentView | undefined> {
  const agent = await deps.store.get(caller.orgId, entry.agentId);
  // A process layer is not an agent a project works with, even if it was put on the roster.
  if (agent === undefined || agent.purpose === "process") return undefined;
  // An agent the caller cannot see is left out entirely: nothing of it, not even that it is there.
  const access = await agentAccess(deps, caller, agent);
  if (!atLeast(access, "view")) return undefined;
  return {
    agentId: agent.agentId, name: agent.name, description: agent.description, builtin: false, status: agent.status, access,
    ...(agent.currentVersion === undefined ? {} : { currentVersion: agent.currentVersion }), addedBy: entry.addedBy, addedAt: entry.addedAt,
  };
}

/**
 * What works on the project: the built-ins the company has not turned off (owners and admins also see those, marked), then the agents
 * added to it. Anyone with a role on the project sees it. The roster is read whole, unless `options.max` is given (the project page shows a few agents): then it reads at most that many entries and logs the cut.
 */
export async function listRoster(deps: RosterDependencies, caller: AgentCaller, project: string, options: { max?: number } = {}): Promise<RosterAgentView[]> {
  await roleOnProject(deps, caller, project);
  const listed: RosterAgentView[] = [];
  for (const builtin of await listVisibleAgents(deps, caller, "builtin")) {
    listed.push({
      agentId: builtin.agentId, name: builtin.name, description: BUILTIN_AGENTS[builtin.agentId as keyof typeof BUILTIN_AGENTS].description, builtin: true, status: "active", access: builtin.access,
      pinnedVersion: await deps.store.pinnedBuiltinVersion(caller.orgId, builtin.agentId), ...(builtin.disabled === true ? { disabled: true as const } : {}),
    });
  }
  // Bounded only for the project page (Plan 5 Task 16 review): a roster longer than its cap lists its first agents, and the cut is logged.
  const entries = await readEntries(deps, caller.orgId, project, options.max === undefined ? undefined : {
    max: options.max, onCut: () => console.log(JSON.stringify({ component: "broker", event: "roster.list_truncated", orgId: caller.orgId, project })),
  });
  for (const entry of entries) {
    const view = await rosterAgentView(deps, caller, entry);
    if (view !== undefined) listed.push(view);
  }
  return listed;
}

// ---- resolving the agent for a run

const MODEL_PROBLEM = /^steps\.(\d+)\.settings\.(model|fallbackModel)$/;

/**
 * Refuses a recipe the company's guardrails now forbid: the first problem with a step's model or fallback model is `MODEL_NOT_ALLOWED`
 * and names the step and model; any other problem is `CONFIG_INVALID` at its path. Nothing when the recipe still passes.
 */
export async function requireRecipeAllowed(deps: RosterDependencies, orgId: OrgId, project: string, agentName: string, recipe: ResolvedRecipe): Promise<void> {
  const problems = await validateRecipeForOrg(deps, orgId, recipe);
  for (const problem of problems) {
    const found = MODEL_PROBLEM.exec(problem.path);
    const step = found === null ? undefined : recipe.steps[Number(found[1])];
    const model = step === undefined ? undefined : (step.settings as Record<string, { provider?: string; modelId?: string } | null | undefined>)[found![2]!];
    if (step !== undefined && model?.provider !== undefined && model.modelId !== undefined) {
      throw agentXError("MODEL_NOT_ALLOWED", `${agentName}'s ${step.name} step uses ${model.provider}/${model.modelId}, which isn't allowed on ${project}. Ask the agent's owner to pick another model.`);
    }
  }
  const first = problems[0];
  if (first !== undefined) throw agentXError("CONFIG_INVALID", `${first.path}: ${first.message}`);
}

const notOnProject = (name: string, project: string) => agentXError("AGENT_NOT_ON_PROJECT", `${name} isn't working on ${project} yet. Ask a project maintainer to add it.`);

/** What every refusal of a process layer says: the same as an agent that is not there (a layer is edited through "How we work", never chosen as an agent). */
const processLayerRefused = () => agentXError("NOT_FOUND", "no agent has that ID");

const processLayerOf = (agent: AgentRecord, project: string): boolean => agent.purpose === "process" && agent.owner.kind === "project" && agent.owner.project === project;

/** A custom agent runs only where a maintainer has put it. */
async function requireOnRoster(deps: RosterDependencies, orgId: OrgId, project: string, agent: AgentRecord): Promise<void> {
  // A project's own process layer is never on the roster (it is kept out of every list of agents); it runs where it belongs, and only as that project's way of working.
  if (processLayerOf(agent, project)) return;
  if (await readEntry(deps, orgId, project, agent.agentId) === undefined) throw notOnProject(agent.name, project);
}

/** Resolves and checks the recipe of the agent chosen; `agent` is the custom agent's record, absent for a built-in. */
async function resolveChosen(
  deps: RosterDependencies,
  orgId: OrgId,
  project: string,
  chosen: { agentId: AgentId; agent: AgentRecord | undefined; version: number | "draft" | undefined; versionApproved?: boolean; autonomous?: boolean },
): Promise<{ recipe: ResolvedRecipe; digest: string; ref: TaskAgentRef }> {
  const { agentId, agent } = chosen;
  let version: number | "draft";
  let draftRevision: number | undefined;
  let draft: AgentDraft | undefined;
  if (agent === undefined) {
    // A built-in runs the version the company pinned (the first use pins the release of the day). A release can be named, but not one
    // above the pin: an org admin adopts a release first (adoptBuiltinVersion), which is where a less-safe one is confirmed.
    const pinned = (await deps.store.ensureBuiltinSettings(orgId, agentId)).pinnedVersion;
    version = typeof chosen.version === "number" ? chosen.version : pinned;
    if (version > pinned) {
      const name = deps.store.builtinName(agentId);
      if (version > deps.store.builtinLatestVersion(agentId)) throw agentXError("NOT_FOUND", `${name} has no version ${String(version)}`);
      throw agentXError("FORBIDDEN", `${name} version ${String(version)} hasn't been adopted by your company yet. An org admin can adopt it first.`);
    }
  } else if (chosen.version === "draft") {
    version = "draft";
    draft = await deps.store.getDraft(orgId, agentId);
    if (draft === undefined) throw agentXError("NOT_FOUND", "no agent has that ID");
    draftRevision = draft.revision;
  } else {
    const current = chosen.version ?? agent.currentVersion;
    if (current === undefined) throw agentXError("AGENT_UNAVAILABLE", `${agent.name} has no published version yet, so it can't start new work.`);
    version = current;
  }
  // A run uses the version that runs now unless one is named. A named published version that is not the current one runs only when it is no looser than the current
  // one (the comparison a publish makes), or an owner has OK'd this very run (`versionApproved`, set by the broker once the approval is decided). Owner decision 2026-10-22.
  if (typeof chosen.version === "number" && version !== "draft" && chosen.versionApproved !== true) {
    const { current, safety } = await versionSafety(deps, orgId, agentId, version, agent);
    if (safety.kind === "less_safe") {
      const name = agent === undefined ? deps.store.builtinName(agentId) : agent.name;
      const unit = agent === undefined ? "the version your company uses" : "the version that runs now";
      throw agentXError("FORBIDDEN", chosen.autonomous === true
        ? `${name} version ${String(version)} is less safe than ${unit} (version ${String(current)}), so it can't be started without a person's OK. Ask the agent's owner to run it, or start the version that runs now.`
        : `${name} version ${String(version)} is less safe than ${unit} (version ${String(current)}): it needs the agent's owner to OK it first.`);
    }
  }
  // The draft read above is the one resolved, so the revision recorded is the revision of the recipe.
  const recipe = await resolveRecipe(deps, orgId, agentId, version, draft);
  const name = agent === undefined ? deps.store.builtinName(agentId) : (recipe.chain.at(-1)?.name ?? agent.name);
  await requireRecipeAllowed(deps, orgId, project, name, recipe);
  const digest = recipeDigest(recipe);
  return { recipe, digest, ref: { agentId, name, version, builtin: agent === undefined, ...(agent?.purpose === "process" ? { process: true as const } : {}), ...(draftRevision === undefined ? {} : { draftRevision }), digest } };
}

/** Whether the project is in the company's catalog. */
async function projectExists(deps: RosterDependencies, orgId: OrgId, project: string): Promise<boolean> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgProjectCatalogKey(orgId, project), ConsistentRead: true })) as { Item?: unknown };
  return response.Item !== undefined;
}

/** The archived-agent refusal, for a run or a roster change that starts new work. */
function requireNotArchived(agent: AgentRecord): void {
  if (agent.status === "archived") throw agentXError("AGENT_UNAVAILABLE", `${agent.name} is archived, so it can't start new work.`);
}

/**
 * The agent a person's run uses, checked in order: 1. the caller's access to the project and that it takes new work (skipped when the
 * caller passes the `role` it has already checked, as the run routes do before they charge anything); 2. no agent named means Rovara Code;
 * 3. `use` on the agent (a turned-off built-in is refused); 4. a draft needs `edit` and is a test run, allowed off the roster; a published
 * version needs `use` and is a normal run; 5. any other custom agent must be on the roster, not archived and published;
 * 6. its recipe is resolved and checked against the guardrails as they stand now.
 */
export async function resolveAgentForTask(
  deps: RosterDependencies,
  caller: AgentCaller,
  input: { project: string; agent?: { agentId: AgentId; version?: number | "draft" }; role?: ProjectRole; versionApproved?: boolean; allowProcessLayer?: boolean },
): Promise<{ recipe: ResolvedRecipe; digest: string; ref: TaskAgentRef; testRun: boolean }> {
  if (input.role === undefined) {
    const { role } = deps.checkProjectAccess === undefined ? { role: await roleOnProject(deps, caller, input.project) } : await deps.checkProjectAccess(caller, input.project);
    await requireNewWorkAllowed(deps, caller.orgId, input.project, role, "task");
  }
  const agentId = input.agent?.agentId ?? ROVARA_CODE_AGENT_ID;
  const version = input.agent?.version;
  const draft = version === "draft";
  const { agent } = await requireAgentAccess(deps, caller, agentId, draft ? "edit" : "use");
  await requireAgentEnabled(deps, caller.orgId, agentId);
  if ("owner" in agent) {
    // A process layer runs only for a start that says it is the project's code intent (`allowProcessLayer`); any other person's run of it is refused. Its draft is never run, not even as a
    // test: a test run starts the whole task-to-pull-request workflow on the draft's recipe, before a second person has confirmed anything the draft weakens (follow-up M4).
    if (agent.purpose === "process" && (draft || input.allowProcessLayer !== true)) throw processLayerRefused();
    if (!draft) await requireOnRoster(deps, caller.orgId, input.project, agent);
    requireNotArchived(agent);
  }
  const resolved = await resolveChosen(deps, caller.orgId, input.project, { agentId, agent: "owner" in agent ? agent : undefined, version, ...(input.versionApproved === true ? { versionApproved: true } : {}) });
  return { ...resolved, testRun: draft };
}

/**
 * The agent an autonomous run (an event, a schedule or a chain step) uses (H3): no person, so no access to read. The project must take new
 * work; a turned-off built-in is refused; a custom agent must be on the roster, not archived and published (`version`, when given, is the
 * published version to run); then its recipe is checked against the guardrails as they stand now.
 */
export async function resolveAgentForAutonomousRun(
  deps: RosterDependencies,
  input: { orgId: OrgId; project: string; agentId: AgentId; version?: number },
): Promise<{ recipe: ResolvedRecipe; digest: string; ref: TaskAgentRef }> {
  if (!await projectExists(deps, input.orgId, input.project)) throw projectNotFound(input.project);
  await requireNewWorkAllowed(deps, input.orgId, input.project, "contributor", "task");
  await requireAgentEnabled(deps, input.orgId, input.agentId);
  let agent: AgentRecord | undefined;
  if (!isBuiltinAgentId(input.agentId)) {
    agent = await deps.store.get(input.orgId, input.agentId);
    if (agent === undefined) throw agentXError("NOT_FOUND", "no agent has that ID");
    // An event, a schedule or a chain step with no person never runs a process layer.
    if (agent.purpose === "process") throw processLayerRefused();
    await requireOnRoster(deps, input.orgId, input.project, agent);
    requireNotArchived(agent);
  }
  return resolveChosen(deps, input.orgId, input.project, { agentId: input.agentId, agent, version: input.version, autonomous: true });
}
