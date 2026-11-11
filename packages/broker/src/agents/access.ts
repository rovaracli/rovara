// Who can do what with an agent: the access level a person holds on it, the shares that give it, the lists of agents a
// person can see and the rules for who may own one. The store (store.ts) holds the records and writes the share set; this
// file decides. Roles on a project come from `ProjectMembers` (Plan 2 Task 21), and a developer merged into another reads
// as the survivor (Plan 2 Task 3) wherever an owner or a share names them.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AGENT_ACCESS_LEVELS,
  AgentPrincipalSchema,
  BUILTIN_AGENT_IDS,
  TRIAL_LIMITS_R49,
  agentXError,
  atLeast,
  isBuiltinAgentId,
  OrgRoleSchema,
  orgMemberKey,
  orgProjectCatalogKey,
  principalKey,
  projectAllows,
  type AgentAccessLevel,
  type AuditProof,
  type AgentId,
  type AgentOwner,
  type AgentPrincipal,
  type BuiltinAgentId,
  type OrgId,
  type OrgRole,
  type ProjectRole,
} from "@agentx/contracts";
import type { AuditRuntime } from "../audit/outbox.js";
import type { DeveloperSignInStore } from "../developer/store.js";
import { readGuardrails } from "./guardrails.js";
import { requireNoSharesOnProcess } from "../playbook/process-closed-routes.js";
import type { AgentRecord, AgentShareLevel, AgentStore, RequestMark } from "./store.js";

/** The A3 interface Plan 2 Task 21 builds (`createProjectMembers`); until it lands, tests use `tests/support/fake-project-members.ts`. */
export interface ProjectMembers {
  roleOf(orgId: OrgId, project: string, caller: { developerId: string; orgRole: OrgRole }): Promise<ProjectRole | undefined>;
  list(orgId: OrgId, project: string): Promise<Array<{ developerId: string; role: ProjectRole; source: "grant" | "org_role" }>>;
  projectsOf(orgId: OrgId, caller: { developerId: string; orgRole: OrgRole }): Promise<Array<{ project: string; role: ProjectRole }>>;
}

export interface AgentAccessDeps {
  store: AgentStore;
  projectMembers: ProjectMembers;
  /** The State table, which holds org membership and the project catalog. */
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Where a developer's `mergedInto` is read (the sign-in table). */
  signInStore: Pick<DeveloperSignInStore, "getDeveloper">;
  /** Overrides how a developer id reads as its survivor; by default it follows `mergedInto` through `signInStore`. */
  resolveDeveloper?: (orgId: OrgId, developerId: string) => Promise<string>;
  /** Where a stored record that can't be read is reported; by default one JSON line on stderr. */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** The Audit Ledger's outbox, for the writes the routes make outside the agent store (the project AI settings, the spend policy); absent on a legacy install. */
  audit?: AuditRuntime;
}

/** What deciding access to an owned thing (an agent or a chain) needs: everything in `AgentAccessDeps` but the agent store. */
export type OwnedAccessDeps = Omit<AgentAccessDeps, "store">;

/** The fields of an agent's or a chain's record that decide who may do what with it. */
export interface OwnedAccessRecord {
  orgId: OrgId;
  owner: AgentOwner;
  accountable?: { developerId: string };
  status: "active" | "archived";
}

export interface AgentCaller {
  orgId: OrgId;
  developerId: string;
  orgRole: OrgRole;
  /**
   * How a decision was made, set only by the decide routes (`requireDecideSession`'s proof) and read only by the audit hooks of the decision.
   * Absent, the decision's event says `{ kind: "none" }`. A request body can never set it.
   */
  decideProof?: AuditProof;
}

/** A custom agent's record, or a built-in (which has no record of its own; the org's settings for it are not access). */
export type AccessibleAgent = AgentRecord | { agentId: BuiltinAgentId };

export interface AgentShare {
  principal: AgentPrincipal;
  level: AgentShareLevel;
}

export interface VisibleAgent {
  agentId: AgentId;
  name: string;
  builtin: boolean;
  access: AgentAccessLevel;
  /** Absent for a built-in. */
  record?: AgentRecord;
  /** A built-in the company's admins turned off; only the admins who can turn it back on are shown it (absent otherwise). */
  disabled?: true;
}

export type AgentScope = "all" | "mine" | "shared" | "builtin" | { project: string };

const MAX_SHARES = 50;
const MAX_MERGE_HOPS = 8;
const ShareLevelSchema = z.enum(["view", "use", "edit"]);
const ShareSchema = z.object({ principal: AgentPrincipalSchema, level: ShareLevelSchema }).strict();

const notFound = () => agentXError("NOT_FOUND", "no agent has that ID");
const invalid = (message: string) => agentXError("CONFIG_INVALID", message);
const isOrgAdmin = (orgRole: OrgRole) => orgRole === "owner" || orgRole === "admin";
const rank = (level: AgentAccessLevel) => AGENT_ACCESS_LEVELS.indexOf(level);
const higher = (left: AgentAccessLevel, right: AgentAccessLevel) => (rank(left) >= rank(right) ? left : right);
const lower = (left: AgentAccessLevel, right: AgentAccessLevel) => (rank(left) <= rank(right) ? left : right);
const isCustom = (agent: AccessibleAgent): agent is AgentRecord => "owner" in agent;
const report = (deps: Pick<AgentAccessDeps, "log">, event: string, fields: Record<string, unknown>) =>
  (deps.log ?? ((name, detail) => console.error(JSON.stringify({ component: "broker", level: "error", event: name, ...detail }))))(event, fields);

/** The developer a record names, read as whoever they were merged into (following a chain of merges, stopping at a loop). */
export async function followMerges(signInStore: Pick<DeveloperSignInStore, "getDeveloper">, developerId: string): Promise<string> {
  const seen = new Set<string>();
  let current = developerId;
  for (let hop = 0; hop < MAX_MERGE_HOPS && !seen.has(current); hop += 1) {
    seen.add(current);
    const next = (await signInStore.getDeveloper(current))?.mergedInto;
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

/** The developer a record names, read as whoever they were merged into (by default through the sign-in table, as `evaluate` does). */
export function resolveSurvivor(deps: Pick<AgentAccessDeps, "signInStore" | "resolveDeveloper">, orgId: OrgId, developerId: string): Promise<string> {
  return deps.resolveDeveloper === undefined ? followMerges(deps.signInStore, developerId) : deps.resolveDeveloper(orgId, developerId);
}

/** One request's reads of developers and project roles, each made once. */
export class Lookups<D extends OwnedAccessDeps = OwnedAccessDeps> {
  private readonly survivors = new Map<string, Promise<string>>();
  private readonly roles = new Map<string, Promise<ProjectRole | undefined>>();

  constructor(readonly deps: D, readonly caller: AgentCaller) {}

  survivor(developerId: string): Promise<string> {
    let found = this.survivors.get(developerId);
    if (found === undefined) {
      found = resolveSurvivor(this.deps, this.caller.orgId, developerId);
      this.survivors.set(developerId, found);
    }
    return found;
  }

  /** The caller's role on a project. */
  role(project: string): Promise<ProjectRole | undefined> {
    let found = this.roles.get(project);
    if (found === undefined) {
      found = this.deps.projectMembers.roleOf(this.caller.orgId, project, { developerId: this.caller.developerId, orgRole: this.caller.orgRole });
      this.roles.set(project, found);
    }
    return found;
  }

  async isCaller(developerId: string): Promise<boolean> {
    return (await this.survivor(developerId)) === this.caller.developerId;
  }
}

/**
 * The agent's stored shares that are a valid principal and level. A row that isn't (a corrupted write) is skipped and reported, so
 * it never gives access, never reads as another principal (`principalKey` maps an unknown kind to the company-wide key) and never
 * makes a read or a save throw.
 */
async function validShares(deps: AgentAccessDeps, orgId: OrgId, agentId: AgentId): Promise<AgentShare[]> {
  return validSharesOf(deps, { orgId, agentId }, () => deps.store.listShares(orgId, agentId), "agent_share_skipped");
}

/** `validShares` for any owned thing: `fields` name it in the report, `list` reads its stored shares, and `event` is what a skipped row is reported as. */
export async function validSharesOf(deps: OwnedAccessDeps, fields: Record<string, unknown>, list: () => Promise<Array<{ principal: unknown; level: unknown }>>, event: string): Promise<AgentShare[]> {
  const valid: AgentShare[] = [];
  for (const share of await list()) {
    const principal = AgentPrincipalSchema.safeParse(share.principal);
    const level = ShareLevelSchema.safeParse(share.level);
    if (!principal.success || !level.success) {
      report(deps, event, { ...fields, reason: "the stored share is not a valid principal and level" });
      continue;
    }
    valid.push({ principal: principal.data, level: level.data });
  }
  return valid;
}

export interface Evaluation {
  access: AgentAccessLevel;
  /** The caller is the member owner, or the accountable maintainer of a project's agent. */
  owns: boolean;
  /** The highest level the shares alone give the caller (`none` when `withShares` was off or none matches). */
  viaShares: AgentAccessLevel;
  /** The projects the agent is shared with (read only when `withShares` is on). */
  sharedProjects: string[];
}

/**
 * What the caller holds on one agent, highest rule winning. Shares are read only when `withShares` is set or the owner rules
 * leave room above their level, so an owner or admin costs no share query.
 */
async function evaluate(lookups: Lookups<AgentAccessDeps>, agent: AccessibleAgent, withShares = false): Promise<Evaluation> {
  const { caller, deps } = lookups;
  const admin = isOrgAdmin(caller.orgRole);
  if (isBuiltinAgentId(agent.agentId)) return { access: admin ? "manage" : "use", owns: false, viaShares: "none", sharedProjects: [] };
  // Anything else needs a record of its own; an id with none gives nothing, to an org admin too.
  if (!isCustom(agent) || agent.orgId !== caller.orgId) return { access: "none", owns: false, viaShares: "none", sharedProjects: [] };
  return evaluateOwned(lookups, agent, () => validShares(deps, agent.orgId, agent.agentId), withShares);
}

/**
 * What the caller holds on one owned thing (an agent or a chain), highest rule winning: an org owner or admin `manage`; a member owner `manage`;
 * for a project's thing a `manage_agents` holder `manage` and a contributor `use`; the shares that name the caller (a project's capped by their
 * role there). Archived caps at `view` for everyone without `manage`. `shares` is read only when `withShares` is set or the owner rules leave
 * room above their level.
 */
export async function evaluateOwned(lookups: Lookups, record: OwnedAccessRecord, shares: () => Promise<AgentShare[]>, withShares = false): Promise<Evaluation> {
  const { caller } = lookups;
  const admin = isOrgAdmin(caller.orgRole);
  let access: AgentAccessLevel = admin ? "manage" : "none";
  let owns = false;
  if (record.owner.kind === "member") {
    owns = await lookups.isCaller(record.owner.developerId);
    if (owns) access = "manage";
  } else {
    const role = await lookups.role(record.owner.project);
    if (role !== undefined && projectAllows(role, "manage_agents")) access = "manage";
    else if (role !== undefined && projectAllows(role, "start_tasks")) access = higher(access, "use");
  }
  if (record.accountable !== undefined && !owns) owns = await lookups.isCaller(record.accountable.developerId);

  let viaShares: AgentAccessLevel = "none";
  const sharedProjects: string[] = [];
  if (withShares || access !== "manage") {
    for (const { principal: stored, level } of await shares()) {
      let given: AgentAccessLevel | undefined;
      if (stored.kind === "org") given = level;
      else if (stored.kind === "member") given = (await lookups.survivor(stored.developerId)) === caller.developerId ? level : undefined;
      else {
        sharedProjects.push(stored.project);
        const role = await lookups.role(stored.project);
        // A viewer of the project sees what is shared with it; they don't run or change it.
        if (role !== undefined) given = role === "viewer" ? lower(level, "view") : level;
      }
      if (given !== undefined) viaShares = higher(viaShares, given);
    }
    access = higher(access, viaShares);
  }
  if (record.status === "archived" && access !== "manage") access = lower(access, "view");
  return { access, owns, viaShares, sharedProjects };
}

/**
 * The access `caller` holds on `agent`. Built-ins: `use` for members, `manage` for org owners and admins (their budget, max per
 * run and pinned version), never `edit`. A custom agent: an org owner or admin `manage`; its member owner `manage`; for a
 * project's agent a `manage_agents` holder `manage` and a contributor `use`; the shares that name the caller (a project's
 * capped by their role there); otherwise `none`. An archived agent is capped at `view` for everyone without `manage`.
 */
export async function agentAccess(deps: AgentAccessDeps, caller: AgentCaller, agent: AccessibleAgent): Promise<AgentAccessLevel> {
  return (await evaluate(new Lookups(deps, caller), agent)).access;
}

/** Who could give the caller `wanted` access to an agent or a chain, in words. */
export function whoNeeds(agent: OwnedAccessRecord, wanted: AgentAccessLevel): string {
  const owners = agent.owner.kind === "project" ? `a maintainer of ${agent.owner.project} or an org admin` : "its owner or an org admin";
  if (agent.status === "archived" && wanted !== "manage") return `${owners} to unarchive it`;
  if (wanted === "manage") return owners;
  if (wanted === "edit") return "its owner or an org admin to give you edit access";
  return "its owner or an org admin to share it with you";
}

/**
 * The agent, when the caller holds at least `wanted` on it. Below `view` the answer is `NOT_FOUND`, the same as for an agent that
 * doesn't exist, so a person can't tell a hidden agent from a missing one; below `wanted` it is `FORBIDDEN` and says what they can do.
 */
export async function requireAgentAccess(
  deps: AgentAccessDeps,
  caller: AgentCaller,
  agentId: AgentId,
  wanted: Exclude<AgentAccessLevel, "none">,
): Promise<{ agent: AccessibleAgent; access: AgentAccessLevel }> {
  const agent: AccessibleAgent | undefined = isBuiltinAgentId(agentId) ? { agentId } : await deps.store.get(caller.orgId, agentId);
  if (agent === undefined) throw notFound();
  const access = await agentAccess(deps, caller, agent);
  if (!atLeast(access, "view")) throw notFound();
  const name = isCustom(agent) ? agent.name : deps.store.builtinName(agent.agentId);
  // A built-in is never edited, whoever asks: `manage` there covers only its budget, max per run and pinned version.
  if (!isCustom(agent) && wanted === "edit") throw agentXError("FORBIDDEN", `Built-in agents can't be edited. Build on ${name} to change it.`);
  if (atLeast(access, wanted)) return { agent, access };
  if (!isCustom(agent)) throw agentXError("FORBIDDEN", `You can ${access} ${name}; manage needs an org owner or admin.`);
  throw agentXError("FORBIDDEN", `You can ${access} ${name}; ${wanted} needs ${whoNeeds(agent, wanted)}.`);
}

/** The agents `caller` can see (`view` or more) in a scope, each with the access they hold. */
export async function listVisibleAgents(deps: AgentAccessDeps, caller: AgentCaller, scope: AgentScope): Promise<VisibleAgent[]> {
  const lookups = new Lookups(deps, caller);
  const visible: VisibleAgent[] = [];
  const wantsBuiltins = scope === "all" || scope === "builtin";
  if (wantsBuiltins) {
    const turnedOff = new Set<string>((await readGuardrails(deps, caller.orgId)).disabledBuiltins);
    for (const agentId of BUILTIN_AGENT_IDS) {
      const off = turnedOff.has(agentId);
      // Members don't see a built-in that is off; owners and admins do, marked, so they can turn it back on.
      if (off && !isOrgAdmin(caller.orgRole)) continue;
      visible.push({ agentId, name: deps.store.builtinName(agentId), builtin: true, access: (await evaluate(lookups, { agentId })).access, ...(off ? { disabled: true as const } : {}) });
    }
  }
  if (scope === "builtin") return visible;
  // A project's list is for people with a role on it; without one there is nothing to show.
  if (typeof scope === "object" && (await lookups.role(scope.project)) === undefined && !isOrgAdmin(caller.orgRole)) return [];

  const needsShares = scope === "shared" || typeof scope === "object";
  for (const record of await deps.store.list(caller.orgId)) {
    // A project's process layer is edited through "How we work", never chosen as an agent.
    if (record.purpose === "process") continue;
    const found = await evaluate(lookups, record, needsShares);
    if (!atLeast(found.access, "view")) continue;
    let included: boolean;
    if (scope === "all") included = true;
    else if (scope === "mine") included = found.owns;
    else if (scope === "shared") included = !found.owns && atLeast(found.viaShares, "view");
    else included = (record.owner.kind === "project" && record.owner.project === scope.project) || found.sharedProjects.includes(scope.project);
    if (included) visible.push({ agentId: record.agentId, name: record.name, builtin: false, access: found.access, record });
  }
  return visible;
}

async function exists(deps: OwnedAccessDeps, key: { pk: string; sk: string }): Promise<boolean> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
  return response.Item !== undefined;
}

/** A member of the org; a developer merged into another is looked for as the survivor. */
async function isOrgMember(deps: OwnedAccessDeps, lookups: Lookups, orgId: OrgId, developerId: string): Promise<boolean> {
  return exists(deps, orgMemberKey(orgId, await lookups.survivor(developerId)));
}

/** A member's role in the org (a developer merged into another is looked for as the survivor), or undefined for someone who isn't a member. */
export async function orgRoleOf(deps: OwnedAccessDeps, orgId: OrgId, developerId: string): Promise<OrgRole | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, await resolveSurvivor(deps, orgId, developerId)), ConsistentRead: true })) as { Item?: { role?: unknown } };
  const role = OrgRoleSchema.safeParse(response.Item?.role);
  return role.success ? role.data : undefined;
}

const isProjectInCatalog = (deps: OwnedAccessDeps, orgId: OrgId, project: string) => exists(deps, orgProjectCatalogKey(orgId, project));

/** Refuses, as `CONFIG_INVALID` at `path`, a principal that isn't in the org: an unknown member or a project not in the catalog. */
async function requirePrincipalExists(deps: OwnedAccessDeps, lookups: Lookups, orgId: OrgId, path: string, principal: AgentPrincipal | AgentOwner): Promise<void> {
  if (principal.kind === "member" && !(await isOrgMember(deps, lookups, orgId, principal.developerId))) throw invalid(`${path}: nobody in your company has that ID`);
  if (principal.kind === "project" && !(await isProjectInCatalog(deps, orgId, principal.project))) throw invalid(`${path}: no project called ${principal.project} in your company`);
}

/** Validates a list of shares: at most 50, each well formed, no principal twice. */
function parseShares(shares: unknown, noun: "agent" | "chain" = "agent"): AgentShare[] {
  if (!Array.isArray(shares)) throw invalid("shares: must be a list");
  if (shares.length > MAX_SHARES) throw invalid(`shares: ${noun === "agent" ? "an agent" : "a chain"} can be shared with at most ${String(MAX_SHARES)} people or groups`);
  const seen = new Set<string>();
  return shares.map((entry: unknown, index) => {
    const parsed = ShareSchema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw invalid(`shares.${String(index)}${issue && issue.path.length > 0 ? `.${issue.path.join(".")}` : ""}: ${issue?.message ?? "is not valid"}`);
    }
    const key = principalKey(parsed.data.principal);
    if (seen.has(key)) throw invalid(`shares.${String(index)}: that person or group is already in the list`);
    seen.add(key);
    return parsed.data;
  });
}

/**
 * Names each member by the developer they were merged into, so a share and its index item are kept under the survivor, and
 * refuses a person who is then in the list twice (`[old id, survivor]`).
 */
async function withSurvivors(lookups: Lookups, shares: AgentShare[]): Promise<AgentShare[]> {
  const seen = new Set<string>();
  const resolved: AgentShare[] = [];
  for (const [index, share] of shares.entries()) {
    const principal: AgentPrincipal = share.principal.kind === "member" ? { kind: "member", developerId: await lookups.survivor(share.principal.developerId) } : share.principal;
    const key = principalKey(principal);
    if (seen.has(key)) throw invalid(`shares.${String(index)}: that person or group is already in the list`);
    seen.add(key);
    resolved.push({ principal, level: share.level });
  }
  return resolved;
}

/**
 * Makes `shares` the agent's whole share set, in one transaction with the share-index items and a `shared` event. The caller needs
 * `manage`; an unknown member or project is `CONFIG_INVALID`. A set that is already the agent's writes nothing. One save changes
 * at most 48 shares (a transaction's size), so replacing a full set of 50 takes two.
 *
 * NO CONFIRMATION: this applies any set, a company-wide share included, to a caller who holds `manage`. No route or tool may call it: a company-wide
 * share goes through `shareAgent` and waits for an org owner or admin on the page (owner decisions 91, 92). `tests/contract/share-writers-gated.test.ts`
 * fails when anything but this file refers to it.
 */
export async function setShares(deps: AgentAccessDeps, caller: AgentCaller, agentId: AgentId, shares: AgentShare[]): Promise<AgentShare[]> {
  if (isBuiltinAgentId(agentId)) throw invalid("Built-in agents belong to the whole company and can't be shared.");
  const { agent } = await requireAgentAccess(deps, caller, agentId, "manage");
  if (!isCustom(agent)) throw notFound();
  return saveShares(deps, caller.orgId, caller.developerId, agent, shares);
}

/**
 * Writes the share set without asking who may: for a caller `setShares` has checked, and for a confirmed pending change, whose
 * decider the approval's rule has already checked (Task 7's `agent_share`). `by` is the developer the `shared` event names.
 */
export async function saveShares(deps: AgentAccessDeps, orgId: OrgId, by: string, agent: AgentRecord, shares: AgentShare[], request?: RequestMark): Promise<AgentShare[]> {
  requireNoSharesOnProcess(agent);
  return saveSharesOf(deps, orgId, by, agent.sharesRevision ?? 0, shares, {
    current: () => validShares(deps, orgId, agent.agentId),
    replace: (change) => deps.store.replaceShares({ orgId, agentId: agent.agentId, ...change }),
  }, request, "agent");
}

/** What `saveSharesOf` needs of the thing whose shares it saves: its valid shares now, and the write that replaces them. */
export interface ShareTarget {
  current(): Promise<AgentShare[]>;
  replace(change: { upsert: AgentShare[]; remove: AgentPrincipal[]; expectedSharesRevision: number; by: string; request?: RequestMark }): Promise<void>;
}

/**
 * `saveShares` for any owned thing. `sharesRevision` is the revision read with the record, before the shares: a save that lands in between
 * leaves this one's revision stale, and it conflicts.
 */
export async function saveSharesOf(deps: OwnedAccessDeps, orgId: OrgId, by: string, sharesRevision: number, shares: AgentShare[], target: ShareTarget, request: RequestMark | undefined, noun: "agent" | "chain"): Promise<AgentShare[]> {
  const wanted = await checkShares(deps, orgId, by, shares, noun);
  const current = new Map((await target.current()).map((share) => [principalKey(share.principal), share]));
  const upsert = wanted.filter((share) => current.get(principalKey(share.principal))?.level !== share.level);
  const keep = new Set(wanted.map((share) => principalKey(share.principal)));
  const remove = [...current].filter(([key]) => !keep.has(key)).map(([, share]) => share.principal);
  if (upsert.length > 0 || remove.length > 0) {
    await target.replace({ upsert, remove, expectedSharesRevision: sharesRevision, by, ...(request === undefined ? {} : { request: { ...request, result: wanted } }) });
  }
  return wanted;
}

/** Whether the agent's stored shares are exactly `shares` (as `checkShares` would store them): a confirmed share that was applied before its record ended. */
export async function sharesAlreadyStored(deps: AgentAccessDeps, orgId: OrgId, by: string, agentId: AgentId, shares: unknown): Promise<boolean> {
  const wanted = await checkShares(deps, orgId, by, shares).catch(() => undefined);
  if (wanted === undefined) return false;
  const current = await validShares(deps, orgId, agentId);
  const key = (share: AgentShare) => `${principalKey(share.principal)}|${share.level}`;
  const have = new Set(current.map(key));
  return have.size === current.length && wanted.length === current.length && wanted.every((share) => have.has(key(share)));
}

/**
 * The shares as they would be stored, or the refusal `saveShares` would give: well formed, at most 50, no person or group twice (after
 * naming each member by the developer they were merged into), and everyone named in the org. Nothing is written.
 */
export async function checkShares(deps: OwnedAccessDeps, orgId: OrgId, by: string, shares: unknown, noun: "agent" | "chain" = "agent"): Promise<AgentShare[]> {
  const lookups = new Lookups(deps, { orgId, developerId: by, orgRole: "member" });
  const wanted = await withSurvivors(lookups, parseShares(shares, noun));
  for (const [index, share] of wanted.entries()) await requirePrincipalExists(deps, lookups, orgId, `shares.${String(index)}`, share.principal);
  return wanted;
}

/**
 * Refuses an owner the caller may not name, for a new agent (or skill, `owns`) or a change of owner (`current` is the owner it has now), and
 * returns the owner to store (a merged member named by their survivor).
 * A member owner must be the caller unless the caller is an org owner or admin; handing an agent to another member, or moving a
 * project's agent to any member (the caller too: the project's other maintainers lose it), takes an org owner or admin; a
 * project owner needs `manage_agents` on that project. The owner must be in the org.
 */
export async function requireOwnerAllowed(deps: OwnedAccessDeps, caller: AgentCaller, owner: AgentOwner, current?: AgentOwner, owns: "an agent" | "a skill" | "a chain" = "an agent"): Promise<AgentOwner> {
  const lookups = new Lookups(deps, caller);
  const admin = isOrgAdmin(caller.orgRole);
  if (owner.kind === "member") {
    const survivor = await lookups.survivor(owner.developerId);
    const self = survivor === caller.developerId;
    const handOver = current !== undefined && (!self || current.kind === "project");
    if (!admin && (!self || handOver)) {
      throw agentXError("FORBIDDEN", current === undefined ? `Only an org owner or admin can make someone else ${owns}'s owner.` : `Only an org owner or admin can hand ${owns === "a chain" ? "a chain" : "an agent"} to another member.`);
    }
    const stored: AgentOwner = { kind: "member", developerId: survivor };
    if (!self) await requirePrincipalExists(deps, lookups, caller.orgId, "owner", stored);
    return stored;
  }
  if (!admin) {
    const role = await lookups.role(owner.project);
    if (role === undefined || !projectAllows(role, "manage_agents")) throw agentXError("FORBIDDEN", `Only a maintainer of ${owner.project} can make it ${owns}'s owner.`);
  }
  await requirePrincipalExists(deps, lookups, caller.orgId, "owner", owner);
  return owner;
}

/** Someone who may answer for a project's agent: in the org, holding `manage_agents` on the project. Returned as the survivor of any merge. */
export async function requireAccountable(deps: AgentAccessDeps, orgId: OrgId, project: string, developerId: string): Promise<{ developerId: string }> {
  const survivor = await resolveSurvivor(deps, orgId, developerId);
  const orgRole = await orgRoleOf(deps, orgId, survivor);
  if (orgRole === undefined) throw agentXError("CONFIG_INVALID", "accountable: nobody in your company has that ID");
  const role = await deps.projectMembers.roleOf(orgId, project, { developerId: survivor, orgRole });
  if (role === undefined || !projectAllows(role, "manage_agents")) throw agentXError("CONFIG_INVALID", `accountable: that person needs to be a maintainer of ${project}`);
  return { developerId: survivor };
}

/**
 * Refuses an agent budget the company's guardrails (Task 8's ceilings) or a trial org's limits (R49) don't allow: checked when the change is asked for, and
 * again when an admin approves it over the owner cap (Task 32), since either may have changed meanwhile.
 */
export async function requireAgentBudgetAllowed(
  deps: Pick<AgentAccessDeps, "documentClient" | "tableName"> & { orgs?: { getOrg(orgId: OrgId): Promise<{ plan?: string } | undefined> } },
  orgId: OrgId, budget: { monthlyUsd?: number | null | undefined; maxPerRunUsd?: number | null | undefined },
): Promise<void> {
  const guardrails = await readGuardrails(deps, orgId);
  if (typeof budget.monthlyUsd === "number" && budget.monthlyUsd > guardrails.maxAgentMonthlyUsd) {
    throw agentXError("CONFIG_INVALID", `monthlyUsd: your company's guardrails allow at most $${String(guardrails.maxAgentMonthlyUsd)} a month for one agent`);
  }
  if (typeof budget.maxPerRunUsd === "number" && budget.maxPerRunUsd > guardrails.maxPerRunCeilingUsd) {
    throw agentXError("CONFIG_INVALID", `maxPerRunUsd: your company's guardrails allow at most $${String(guardrails.maxPerRunCeilingUsd)} for one run`);
  }
  const trialCap = TRIAL_LIMITS_R49.agentMonthlyUsd;
  if (typeof budget.monthlyUsd === "number" && budget.monthlyUsd > trialCap && (await deps.orgs?.getOrg(orgId))?.plan === "trial") {
    throw agentXError("CONFIG_INVALID", `monthlyUsd: a trial organization's agent budget is at most $${String(trialCap)} a month; upgrade the plan to raise it`);
  }
}
