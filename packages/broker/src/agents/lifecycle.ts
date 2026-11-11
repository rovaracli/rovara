// packages/broker/src/agents/lifecycle.ts
// Plan 3 Task 11: what follows a member being merged into another member, a member being removed, or a project being archived.
//
// A merge is done by the sign-in function, which has no business with agents: in the merge's own transaction it leaves one marker in the
// sparse `MEMBER_MERGE_QUEUE` partition (ids and the org only). The broker's 5-minute settlement run (`runMemberMergeDrain`) lists the
// partition oldest first, checks each merge really happened (R2-5), runs every registered mover and deletes the marker. A removal is
// run by the broker itself, at once, and leaves the same kind of marker in the removal's transaction until the moves are done, so a broker
// that stopped half-way is finished by the next run. Every move is conditional on what it read, so a repeat, or a run that stopped after
// some moves, changes nothing twice.
//
// A "mover" is one kind of thing a member can own or be named on. This file registers the ones of this task (agents, skills, shares,
// accountable); the approvals (Task 21) and the spend requests (Task 32) register theirs with `registerMemberMover`.
//
// Until the drain has run, readers see through the merge: `resolveMember` follows the duplicate's `mergedInto`, which access (Task 6) and the
// deciders of approvals and spend requests use.
import { deleteChosenNameOfRemoved } from "../developer/chosen-name.js";
import { DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BUILTIN_AGENT_IDS, orgPk, projectAgentKey, projectAllows, type AgentId, type AgentPrincipal, type EndDeveloperSessionsRequest, type EndDeveloperSessionsResponse, type OrgId, type OrgKey } from "@rovara-code/contracts";
import { MEMBER_MERGE_QUEUE_PK, MEMBER_REMOVAL_QUEUE_PK, MEMBER_REMOVAL_SUCCESSOR_HOPS, memberRemovalRecordKey, orgMemberKey, orgRemovedKey, type MemberRemovalRecord } from "@agentx/cloud-contracts";
import { runAccessStep, type AccessStepResult } from "../org/member-removal/access.js";
import { finishRemoval } from "../org/member-removal/finish.js";
import type { MemberRemovalHook } from "../org/store.js";
import { checkOwnerBudget } from "../spend/settings.js";
import { orgRoleOf, resolveSurvivor, type AgentAccessDeps } from "./access.js";
import type { MoveCause } from "./store.js";

/** What the lifecycle hooks need: the agent routes' own dependencies (`AgentRouteDependencies` is one). */
export interface LifecycleDeps extends AgentAccessDeps {
  now: () => number;
  /**
   * When set, the movers stop between two items once `now()` has passed it, failing with `LifecycleDeadline`. The removal that runs inside an
   * API request sets it, and leaves the rest to its queued marker; the settlement run has its own budget and leaves it unset.
   */
  deadline?: number;
  /**
   * Ends a person's sign-in sessions through DeveloperIdentity (the sign-in step of a removal). Absent on an install with no sign-in function: the step is then skipped and
   * logged, and the route that removed the person ends them itself.
   */
  endDeveloperSessions?: (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse>;
}

/** A merge that happened: `duplicateId` is now `survivorId`, in `orgId`. */
export interface MergedMembers {
  orgId: OrgId;
  survivorId: string;
  duplicateId: string;
}

/** A member who is no longer in the org. `successorId` is the first owner of the org, who takes what the person owned; `by` is who removed them. */
export interface RemovedMember {
  orgId: OrgId;
  developerId: string;
  by: string;
  successorId: string;
}

/** A member who is no longer in the org, in an org that has no owner left to hand anything to. */
export interface OrphanedMember {
  orgId: OrgId;
  developerId: string;
  by: string;
}

/**
 * One kind of thing a member can own or be named on. `merged` hands the duplicate's to the survivor; `removed` hands the removed person's
 * to the successor (or drops it). Both must be repeatable: they run again after a run that stopped half-way. Throwing leaves the marker.
 * `orphaned` runs instead of `removed` when the org has no owner to be the successor (the last owner left, or the org closed under the
 * removal): a mover that can still do its part without a successor (turn something off and tell an admin, drop what the person held) does it.
 * A mover that gave something with a budget to someone answers their ids, once any of it moved, so their per-person cap is looked at after
 * every mover has run (see `noteOwnerCap`).
 */
export interface MemberMover {
  /** Names the mover: registering a name again replaces it. */
  name: string;
  merged?(deps: LifecycleDeps, merge: MergedMembers): Promise<void | readonly string[]>;
  removed?(deps: LifecycleDeps, removal: RemovedMember): Promise<void | readonly string[]>;
  orphaned?(deps: LifecycleDeps, removal: OrphanedMember): Promise<void>;
  /**
   * Member removal (v1.1): a step of the CUT-OFF. It runs on every run of a removal, also when the person has rejoined since (a rejoin cancels only the hand-offs), so it
   * must cut only what was theirs before `removedAt` when `rejoined` is true. Repeatable.
   */
  cutOff?(deps: LifecycleDeps, cut: CutOff): Promise<void>;
  /**
   * Runs instead of `removed` and `orphaned` when the person has rejoined: drops what the leaver was listed for before `removedAt`, hands nothing to anyone. Repeatable.
   */
  dropped?(deps: LifecycleDeps, cut: CutOff): Promise<void>;
}

/** What a cut-off step is told about a removal. `removedAt` is S0's commit time (absent for a caller that does not know it: the step then cuts everything). */
export interface CutOff {
  orgId: OrgId;
  developerId: string;
  by: string;
  removedAt?: string;
  /** The person is a member again. */
  rejoined: boolean;
}

/** What one run of a removal is told: the person, who removed them, and what S0 recorded on the marker (a marker from before this release has none of it). */
export interface RemovalEvent {
  orgId: OrgId;
  developerId: string;
  by: string;
  removalId?: string | undefined;
  removedAt?: string | undefined;
  successorId?: string | undefined;
  /** The marker, deleted by the removal's last step. */
  marker?: OrgKey | undefined;
  /** How many runs of this removal failed before (the marker's attempts). */
  attempts?: number | undefined;
}

const movers = new Map<string, MemberMover>();

/** Registers (or replaces) a mover. The returned function unregisters it. */
export function registerMemberMover(mover: MemberMover): () => void {
  movers.set(mover.name, mover);
  return () => {
    if (movers.get(mover.name) === mover) movers.delete(mover.name);
  };
}

type Item = Record<string, unknown>;
type Fields = Record<string, unknown>;

/** Everything Rovara changes itself is recorded as the system's. */
const SYSTEM = "system";
const MEMBER_ID = /^[a-f0-9]{64}$/;
const ORG_ID = /^org_[0-9a-z]{20}$/;
const MARKER_SK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#(org_[0-9a-z]{20})#([a-f0-9]{64})$/;
const PAGE = 100;
const CONFLICT_RETRIES = 3;
/** How long the moves of a removal may take inside the request that removed the person; the rest is left to the removal's marker. */
const REQUEST_MOVE_BUDGET_MS = 2_000;
/** A marker that fails waits 5 minutes, then 10, then 20, up to an hour, before it is tried again; from the 12th failure it is parked (logged at error level, still retried hourly). */
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;
const PARK_AFTER_ATTEMPTS = 12;
const backoffMs = (attempts: number) => Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));

/** The moves ran out of the time their caller gave them (`LifecycleDeps.deadline`). */
class LifecycleDeadline extends Error {
  override readonly name = "LifecycleDeadline";
}
export function checkTime(deps: Pick<LifecycleDeps, "deadline" | "now">): void {
  if (deps.deadline !== undefined && deps.now() >= deps.deadline) throw new LifecycleDeadline("the time for these moves has run out");
}

const defaultLog = (event: string, fields: Fields): void => {
  console.log(JSON.stringify({ component: "broker", event, ...fields }));
};
const log = (deps: LifecycleDeps, event: string, fields: Fields): void => (deps.log ?? defaultLog)(event, fields);
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

// ---- reading the merge record

/** The member a (possibly merged-away) developer id stands for: the end of its `mergedInto` chain, or the id itself. */
export function resolveMember(deps: Pick<LifecycleDeps, "signInStore" | "resolveDeveloper">, orgId: OrgId, developerId: string): Promise<string> {
  return resolveSurvivor(deps, orgId, developerId);
}

/** Whether two developer ids are one person, a merged duplicate counting as the member it was merged into. */
export async function sameMember(deps: Pick<LifecycleDeps, "signInStore" | "resolveDeveloper">, orgId: OrgId, left: string, right: string): Promise<boolean> {
  if (left === right) return true;
  const [first, second] = await Promise.all([resolveMember(deps, orgId, left), resolveMember(deps, orgId, right)]);
  return first === second;
}

// ---- reading the org

async function queryAll(deps: LifecycleDeps, pk: string, prefix?: string): Promise<Item[]> {
  const found: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: prefix === undefined ? { ":pk": pk } : { ":pk": pk, ":prefix": prefix },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    found.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return found;
}

async function isMember(deps: LifecycleDeps, orgId: OrgId, developerId: string): Promise<boolean> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true })) as { Item?: Item };
  return response.Item !== undefined;
}

/**
 * The first owner of the org other than `except`: the owner who joined first (then by id). A member who was merged away is not one, since the
 * person is their survivor, who is listed on their own. Undefined when the org has no such owner.
 */
async function firstOwner(deps: LifecycleDeps, orgId: OrgId, except: string): Promise<string | undefined> {
  const owners = (await queryAll(deps, orgPk(orgId), "MEMBER#"))
    .filter((member) => member["role"] === "owner" && typeof member["developerId"] === "string" && member["developerId"] !== except)
    .sort((a, b) => String(a["joinedAt"]).localeCompare(String(b["joinedAt"])) || String(a["developerId"]).localeCompare(String(b["developerId"])));
  for (const owner of owners) {
    const id = owner["developerId"] as string;
    if (await resolveMember(deps, orgId, id) === id) return id;
  }
  return undefined;
}

// ---- the movers of this task

const isConflict = (error: unknown) => (error as { code?: string } | null)?.code === "AGENT_REVISION_CONFLICT";

/** Runs `attempt` again when something else changed the agent in between; `attempt` reads what it needs again each time. */
async function untilSettled(attempt: () => Promise<void>): Promise<void> {
  for (let tried = 1; ; tried += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isConflict(error) || tried >= CONFLICT_RETRIES) throw error;
    }
  }
}

/** What asks an org admin to confirm a move that left someone over the cap (Task 32 registers it: spend/requests.ts, `confirmOwnerMove`). */
type OwnerCapConfirmation = (deps: LifecycleDeps, orgId: OrgId, owner: string, reason: MoveCause["kind"], totals: { totalUsd: number; capUsd: number; policyRevision?: number; counterVersion?: number }) => Promise<unknown>;
let confirmOwnerCap: OwnerCapConfirmation | undefined;

/** Registers what asks an org admin to confirm a move over the cap (the spend requests do, PF27). The returned function unregisters it. */
export function registerOwnerCapConfirmation(confirm: OwnerCapConfirmation): () => void {
  confirmOwnerCap = confirm;
  return () => {
    if (confirmOwnerCap === confirm) confirmOwnerCap = undefined;
  };
}

/**
 * After a move, the new owner's agent budgets may total more than one person may have. Rovara's own move applies at once and counts; what is
 * left is asking an org admin to confirm it: an `owner_cap` spend request (Task 32, `confirmOwnerMove`), once per person while one is open. Exactly at
 * the cap asks nothing. A request that can't be made is logged, and the next run of the moves (or a later move) asks again.
 */
async function noteOwnerCap(deps: LifecycleDeps, orgId: OrgId, owner: string, reason: MoveCause["kind"]): Promise<void> {
  try {
    const check = await checkOwnerBudget(deps, { orgId, owner, deltaUsd: 0 });
    if (check.totalUsd <= check.capUsd) return;
    if (confirmOwnerCap === undefined) {
      log(deps, "owner_cap.exceeded_by_move", { orgId, owner, totalUsd: check.totalUsd, capUsd: check.capUsd, reason });
      return;
    }
    await confirmOwnerCap(deps, orgId, owner, reason, { totalUsd: check.totalUsd, capUsd: check.capUsd, policyRevision: check.policyRevision, ...(check.counterVersion === undefined ? {} : { counterVersion: check.counterVersion }) });
  } catch (error) {
    log(deps, "owner_cap.check_failed", { orgId, owner, reason, error: errorName(error) });
  }
}

/** Member-owned agents of `from` become `to`'s, one `owner_changed` event each. Answers `to` when any moved. */
async function moveAgents(deps: LifecycleDeps, orgId: OrgId, from: string, to: string, cause: MoveCause): Promise<readonly string[]> {
  let moved = 0;
  for (const agent of await deps.store.list(orgId)) {
    if (agent.owner.kind !== "member" || agent.owner.developerId !== from) continue;
    checkTime(deps);
    await untilSettled(async () => {
      const current = await deps.store.get(orgId, agent.agentId);
      if (current === undefined || current.owner.kind !== "member" || current.owner.developerId !== from) return;
      await deps.store.setOwner(orgId, agent.agentId, { kind: "member", developerId: to }, SYSTEM, undefined, undefined, { cause });
      moved += 1;
    });
  }
  return moved === 0 ? [] : [to];
}

/** Skills of `from` become `to`'s. */
async function moveSkills(deps: LifecycleDeps, orgId: OrgId, from: string, to: string): Promise<void> {
  for (const skill of await deps.store.skills.list(orgId)) {
    if (skill.owner.kind !== "member" || skill.owner.developerId !== from) continue;
    checkTime(deps);
    await deps.store.skills.moveOwner(orgId, skill.skillId, skill.owner, { kind: "member", developerId: to });
  }
}

/** Shares naming `from` become `to`'s, or are dropped when there is no `to`. */
async function moveShares(deps: LifecycleDeps, orgId: OrgId, from: string, to: string | undefined, cause: MoveCause): Promise<void> {
  const principal = (developerId: string): AgentPrincipal => ({ kind: "member", developerId });
  for (const agentId of await deps.store.listSharedWith(orgId, principal(from))) {
    checkTime(deps);
    await deps.store.reassignShare({ orgId, agentId, from: principal(from), ...(to === undefined ? {} : { to: principal(to) }), by: SYSTEM, cause });
  }
}

/**
 * The accountable maintainer `from` of an agent becomes whoever `replacement` names for its project (a built-in has none). Answers who took over.
 * With `onlyProject`, only that project's agents move (and no built-in): the person is still accountable elsewhere.
 */
async function moveAccountable(deps: LifecycleDeps, orgId: OrgId, from: string, replacement: (project: string | undefined) => Promise<string>, cause: MoveCause, onlyProject?: string): Promise<readonly string[]> {
  const took = new Set<string>();
  const give = async (agentId: AgentId, project: string | undefined, current: () => Promise<string | undefined>) => {
    await untilSettled(async () => {
      if (await current() !== from) return;
      const to = await replacement(project);
      await deps.store.setAccountable(orgId, agentId, { developerId: to }, SYSTEM, undefined, { cause });
      took.add(to);
    });
  };
  for (const agent of await deps.store.list(orgId)) {
    if (agent.accountable?.developerId !== from) continue;
    if (onlyProject !== undefined && !(agent.owner.kind === "project" && agent.owner.project === onlyProject)) continue;
    checkTime(deps);
    await give(agent.agentId, agent.owner.kind === "project" ? agent.owner.project : undefined, async () => (await deps.store.get(orgId, agent.agentId))?.accountable?.developerId);
  }
  for (const builtin of onlyProject === undefined ? BUILTIN_AGENT_IDS : []) {
    if ((await deps.store.getBuiltinSettings(orgId, builtin))?.accountable?.developerId !== from) continue;
    checkTime(deps);
    await give(builtin, undefined, async () => (await deps.store.getBuiltinSettings(orgId, builtin))?.accountable?.developerId);
  }
  return [...took];
}

registerMemberMover({
  name: "agents",
  merged: (deps, { orgId, survivorId, duplicateId }) => moveAgents(deps, orgId, duplicateId, survivorId, { kind: "member_merged", developerId: duplicateId }),
  removed: (deps, { orgId, developerId, successorId }) => moveAgents(deps, orgId, developerId, successorId, { kind: "member_removed", developerId }),
});

registerMemberMover({
  name: "skills",
  merged: (deps, { orgId, survivorId, duplicateId }) => moveSkills(deps, orgId, duplicateId, survivorId),
  removed: (deps, { orgId, developerId, successorId }) => moveSkills(deps, orgId, developerId, successorId),
});

registerMemberMover({
  name: "shares",
  merged: (deps, { orgId, survivorId, duplicateId }) => moveShares(deps, orgId, duplicateId, survivorId, { kind: "member_merged", developerId: duplicateId }),
  // A person who is gone keeps no share: it is deleted, not handed to the owner (who already manages what they took over). This is a step of the cut-off: it runs also when the
  // person has rejoined, and then drops every share (a share carries no time, so one given after the rejoin goes too: the safer side; an admin shares again).
  cutOff: (deps, { orgId, developerId }) => moveShares(deps, orgId, developerId, undefined, { kind: "member_removed", developerId }),
});

/** Another maintainer of the project by grant, else `fallback` (the first owner of the org): who takes over what `leaving` is accountable for on the project. */
async function otherMaintainer(deps: LifecycleDeps, orgId: OrgId, project: string | undefined, leaving: string, fallback: string): Promise<string> {
  if (project !== undefined) {
    for (const row of await deps.projectMembers.list(orgId, project)) {
      if (row.role === "maintainer" && row.source === "grant" && row.developerId !== leaving) return row.developerId;
    }
  }
  return fallback;
}

registerMemberMover({
  name: "accountable",
  merged: (deps, { orgId, survivorId, duplicateId }) => moveAccountable(deps, orgId, duplicateId, async () => survivorId, { kind: "member_merged", developerId: duplicateId }),
  removed: (deps, { orgId, developerId, successorId }) => moveAccountable(deps, orgId, developerId, (project) => otherMaintainer(deps, orgId, project, developerId, successorId), { kind: "member_removed", developerId }),
});

/**
 * A person's role in a project changed or their grant was removed (final review, access m-2). When they no longer hold `manage_agents` on it (read now: an
 * org owner or admin still does), the project's agents they were accountable for go to another maintainer of the project by grant, else the first owner
 * of the org, as a removal from the org does, so the Task 6 invariant (accountable holds `manage_agents`) and the owner's budget total stay true. Repeatable;
 * their other projects' agents and any built-in stay with them. The owner cap is looked at for whoever took over.
 */
export async function onProjectMemberChanged(deps: LifecycleDeps, change: { orgId: OrgId; project: string; developerId: string }): Promise<void> {
  const { orgId, project, developerId } = change;
  const orgRole = await orgRoleOf(deps, orgId, developerId);
  const role = orgRole === undefined ? undefined : await deps.projectMembers.roleOf(orgId, project, { developerId, orgRole });
  if (role !== undefined && projectAllows(role, "manage_agents")) return;
  const successorId = await firstOwner(deps, orgId, developerId);
  if (successorId === undefined) {
    log(deps, "project_member.no_successor", { orgId, project, developerId });
    return;
  }
  const took = await moveAccountable(deps, orgId, developerId, (agentProject) => otherMaintainer(deps, orgId, agentProject, developerId, successorId), { kind: "project_role_changed", developerId }, project);
  for (const owner of took) await noteOwnerCap(deps, orgId, owner, "project_role_changed");
}

/**
 * Runs every registered mover with `run`, each even when another failed. Answers the people the movers gave budgeted things to (also when some
 * failed, so a caller can remember them) and the first failure, if any.
 */
async function runMovers(deps: LifecycleDeps, event: string, fields: Fields, run: (mover: MemberMover) => Promise<void | readonly string[]> | undefined): Promise<{ owners: Set<string>; failure?: unknown }> {
  const failures: unknown[] = [];
  const owners = new Set<string>();
  for (const mover of [...movers.values()]) {
    try {
      for (const owner of await run(mover) ?? []) owners.add(owner);
    } catch (error) {
      failures.push(error);
      log(deps, event, { ...fields, mover: mover.name, error: errorName(error) });
    }
  }
  return failures.length > 0 ? { owners, failure: failures[0] } : { owners };
}

/**
 * Who a change gave budgeted things to, kept on its marker, so a later run that moves nothing (the first did it all, then something failed)
 * still looks at their cap once it succeeds. `carried` is what earlier runs remembered; `remember` stores the union so far.
 */
export interface RecipientLedger {
  carried: readonly string[];
  remember(recipients: readonly string[]): Promise<void>;
}

/** A ledger that keeps its recipients on the marker item at `key` (best effort: the item may be gone). */
function markerLedger(deps: LifecycleDeps, key: { pk: string; sk: string }, carried: readonly string[]): RecipientLedger {
  return {
    carried,
    remember: async (recipients) => {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: key, UpdateExpression: "SET #recipients = :recipients", ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#recipients": "recipients" }, ExpressionAttributeValues: { ":recipients": [...recipients] },
      }));
    },
  };
}

async function remember(deps: LifecycleDeps, orgId: OrgId, ledger: RecipientLedger | undefined, recipients: ReadonlySet<string>): Promise<void> {
  if (ledger === undefined || recipients.size === 0) return;
  try {
    await ledger.remember([...recipients]);
  } catch (error) {
    log(deps, "member_move.recipients_not_kept", { orgId, error: errorName(error) });
  }
}

// ---- merges and removals

/**
 * The duplicate's things become the survivor's: member-owned agents and skills, `accountable` ids, share and share-index items, and whatever
 * other movers are registered (the approvals and spend requests addressed to the duplicate). Repeatable. Then the totals of the agent
 * budgets are rebuilt, because the duplicate's agents were counted under the duplicate until now (Task 28). Who the marker says merged is
 * checked by `drainMemberMerges`, not here. When the run succeeds, the cap is looked at for the survivor and for everyone a mover (this run's
 * or an earlier one's, through `ledger`) gave something to.
 */
export async function onMembersMerged(deps: LifecycleDeps, merge: MergedMembers, ledger?: RecipientLedger): Promise<void> {
  const { owners, failure } = await runMovers(deps, "member_merge.mover_failed", { orgId: merge.orgId, duplicateId: merge.duplicateId }, (mover) => mover.merged?.(deps, merge));
  const recipients = new Set([...(ledger?.carried ?? []), ...owners]);
  await remember(deps, merge.orgId, ledger, recipients);
  const failures: unknown[] = failure === undefined ? [] : [failure];
  for (const owner of [merge.survivorId, merge.duplicateId]) {
    try {
      await deps.store.rebuildOwnerTotal(merge.orgId, owner);
    } catch (error) {
      failures.push(error);
      log(deps, "member_merge.total_failed", { orgId: merge.orgId, owner, error: errorName(error) });
    }
  }
  if (failures.length > 0) throw failures[0];
  recipients.add(merge.survivorId);
  for (const owner of recipients) await noteOwnerCap(deps, merge.orgId, owner, "member_merged");
}

/**
 * The successor of a removal, read again at each run: the one S0 recorded (or, if they have left since, the one they were replaced by, up to
 * `MEMBER_REMOVAL_SUCCESSOR_HOPS` hops), else the person who removed them, else the first owner. A marker from before this release names no successor and keeps today's
 * rule: the first owner. Undefined when the org has nobody to hand anything to.
 */
async function resolveSuccessor(deps: LifecycleDeps, removal: RemovalEvent): Promise<string | undefined> {
  const { orgId, developerId, by } = removal;
  const stillThere = async (id: string) => id !== developerId && await isMember(deps, orgId, id) && await resolveMember(deps, orgId, id) === id;
  if (removal.successorId !== undefined) {
    let candidate: string | undefined = removal.successorId;
    for (let hop = 0; candidate !== undefined && hop <= MEMBER_REMOVAL_SUCCESSOR_HOPS; hop += 1) {
      if (await stillThere(candidate)) return candidate;
      const tombstone = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgRemovedKey(orgId, candidate), ConsistentRead: true })) as { Item?: Item };
      const next: unknown = tombstone.Item?.["successorId"];
      candidate = typeof next === "string" ? next : undefined;
    }
    if (MEMBER_ID.test(by) && await stillThere(by)) return by;
  }
  return firstOwner(deps, orgId, developerId);
}

/**
 * Ends the person's sign-in sessions at the removal's own time, through the sign-in function; false when there is none wired (nothing was ended). A `not_found` answer is an
 * answer (they never signed in); any other failure fails the run.
 */
async function endSessionsAt(deps: LifecycleDeps, developerId: string, at: string): Promise<boolean> {
  if (deps.endDeveloperSessions === undefined) {
    log(deps, "member_removal.sign_in_not_wired", { developerId });
    return false;
  }
  const answer = await deps.endDeveloperSessions({ kind: "end-developer-sessions", developerId, at });
  if (!answer.ok && answer.error !== "not_found") throw new Error(`member_removal_sign_in_${answer.error}`);
  return true;
}

async function readRemovalRecord(deps: LifecycleDeps, orgId: OrgId, removalId: string): Promise<MemberRemovalRecord | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: memberRemovalRecordKey(orgId, removalId), ConsistentRead: true })) as { Item?: MemberRemovalRecord };
  return response.Item;
}

/**
 * A run of a member's removal (the request's own, within its budget, or the sweep's). In two parts:
 *
 * 1. The CUT-OFF always runs, also when the person has rejoined since: the grants, the leftover email pointers and the monthly limit S0 recorded (`access`), the sign-in sessions
 *    (ended at the removal's own time, never "now"), and every mover's `cutOff` (shares, follows, devices). After a rejoin they cut only what was there before the removal.
 * 2. The HAND-OFFS run only while the person is still not a member: what they owned moves to the successor (agents, skills, accountable, chains, triggers, the approvals and
 *    spend requests that list them, with `requestedBy` kept), read again at every mover. An org with nobody to hand anything to runs each mover's `orphaned` part. After a
 *    rejoin the hand-offs are cancelled (logged), and the approvals and spend requests that listed them before the removal are only dropped (`dropped`).
 *
 * Repeatable: every step is conditional on what it read. When all of it succeeded, the removal's record ends and its marker goes (`finishRemoval`, S7); a failure leaves the marker,
 * and the sweep runs this again. When the run succeeds, the cap is looked at for the successor and for everyone a mover (this run's or an earlier one's, through `ledger`) gave
 * something to.
 */
export async function onMemberRemoved(deps: LifecycleDeps, removal: RemovalEvent, ledger?: RecipientLedger): Promise<void> {
  const { orgId, developerId, by } = removal;
  const record = removal.removalId === undefined ? undefined : await readRemovalRecord(deps, orgId, removal.removalId);
  const fields = { orgId, developerId };
  // A removal that is already finished (a repeat, or a marker left behind): only the marker is left to remove.
  if (record !== undefined && record.state !== "STARTED") {
    if (removal.marker !== undefined) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: removal.marker }));
    return;
  }
  const failures: unknown[] = [];
  const attempt = async <T>(step: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      failures.push(error);
      log(deps, "member_removed.mover_failed", { ...fields, mover: step, error: errorName(error) });
      return undefined;
    }
  };
  const { removedAt } = removal;
  // ---- the cut-off
  let access: AccessStepResult | undefined;
  if (record !== undefined) {
    access = await attempt("access", () => runAccessStep(
      { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) },
      { orgId, leaverId: developerId, removedAt: record.removedAt, grants: record.grants, memberLimitUsd: record.memberLimitUsd, leftoverEmailPointers: record.leftoverEmailPointers },
    ));
  }
  let signInEnded = false;
  if (removedAt !== undefined) signInEnded = (await attempt("sign-in", () => endSessionsAt(deps, developerId, removedAt))) === true;
  // ERASE-NAME-1: the name the person chose goes with their membership (only one chosen before the removal, so a person who came back and chose again keeps it). The sign-in record's own name shows from then on.
  if (removedAt !== undefined) await attempt("chosen-name", () => deleteChosenNameOfRemoved(deps.documentClient, deps.tableName, developerId, removedAt));
  const rejoinedAtStart = removedAt !== undefined && await isMember(deps, orgId, developerId);
  const cut: CutOff = { orgId, developerId, by, ...(removedAt === undefined ? {} : { removedAt }), rejoined: rejoinedAtStart };
  const cutResult = await runMovers(deps, "member_removed.mover_failed", fields, (mover) => mover.cutOff?.(deps, cut));
  if (cutResult.failure !== undefined) failures.push(cutResult.failure);

  // ---- the hand-offs
  const owners = new Set<string>();
  let cancelled = rejoinedAtStart;
  let lastSuccessor: string | undefined;
  if (!cancelled) {
    for (const mover of [...movers.values()]) {
      // Read again at every mover: the person may have come back, and the successor may have left.
      // (Only for a removal that says when it happened: a caller that does not know is told the person is gone.)
      if (removedAt !== undefined && await isMember(deps, orgId, developerId)) { cancelled = true; break; }
      try {
        const successorId = await resolveSuccessor(deps, removal);
        if (successorId === undefined) {
          log(deps, "member_removed.no_successor", fields);
          await mover.orphaned?.(deps, { orgId, developerId, by });
        } else {
          lastSuccessor = successorId;
          for (const owner of await mover.removed?.(deps, { orgId, developerId, by, successorId }) ?? []) owners.add(owner);
          // The movers that write item by item (agents, skills, chains, triggers) read the successor once per page: one removed since got what moved. Their own removal moves it on
          // when it has not finished; otherwise this line is what an admin finds it by.
          if (!await isMember(deps, orgId, successorId)) log(deps, "member_removal.moved_to_removed", { ...fields, successorId, mover: mover.name });
        }
      } catch (error) {
        failures.push(error);
        log(deps, "member_removed.mover_failed", { ...fields, mover: mover.name, error: errorName(error) });
      }
    }
  }
  if (cancelled) {
    log(deps, "member_removal.handoffs_cancelled", fields);
    const dropResult = await runMovers(deps, "member_removed.mover_failed", fields, (mover) => mover.dropped?.(deps, { ...cut, rejoined: true }));
    if (dropResult.failure !== undefined) failures.push(dropResult.failure);
  }
  const recipients = new Set([...(ledger?.carried ?? []), ...owners]);
  await remember(deps, orgId, ledger, recipients);
  if (failures.length > 0) throw failures[0] as Error;
  if (lastSuccessor !== undefined) recipients.add(lastSuccessor);
  for (const owner of recipients) await noteOwnerCap(deps, orgId, owner, "member_removed");

  // ---- S7
  if (record !== undefined) {
    await finishRemoval(
      { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) },
      {
        orgId, removalId: record.removalId, leaverId: developerId, role: record.role, successorId: record.successorId, by: record.by, outcome: cancelled ? "cancelled_rejoined" : "done",
        counts: { ...(access === undefined ? {} : { grantsRemoved: access.grantsRemoved, grantsKept: access.grantsKept }), signInEnded, countsComplete: (removal.attempts ?? 0) === 0 },
        marker: removal.marker,
      },
    );
  }
}

/**
 * What `OrgStore.removeMember` calls once a member is removed (and the sweep calls again if it failed). It works for at most `budgetMs`
 * (2 seconds by default) inside the request; whatever is left stays with the removal's marker for the sweep.
 */
export function memberRemovalHook(deps: LifecycleDeps, options: { budgetMs?: number } = {}): MemberRemovalHook {
  const budgetMs = options.budgetMs ?? REQUEST_MOVE_BUDGET_MS;
  return { onRemoved: (event) => onMemberRemoved({ ...deps, deadline: deps.now() + budgetMs }, event, markerLedger(deps, event.marker, [])) };
}

// ---- the queues

/**
 * What one sweep of a queue did. `next` is where the next page starts; `stopped` says it ran out of time before the end of the page; `skipped`
 * counts markers still waiting out the back-off of an earlier failure (absent when none).
 */
export interface DrainReport {
  processed: number;
  rejected: number;
  failed: number;
  skipped?: number;
  next?: string;
  stopped?: true;
}

type Queue = "merge" | "removal";
type Marker =
  | { kind: "merged"; orgId: OrgId; survivorId: string; duplicateId: string }
  | { kind: "removed"; orgId: OrgId; developerId: string; by: string; removalId?: string; removedAt: string; successorId?: string };

const QUEUE_PK: Record<Queue, string> = { merge: MEMBER_MERGE_QUEUE_PK, removal: MEMBER_REMOVAL_QUEUE_PK };

/**
 * A marker as the partition, the key and the item say it, or undefined when they do not agree (the org in the key is the org on the item, the
 * ids are ids, the item is the kind its partition holds). A removal is only ever read from the broker-only removal queue.
 */
function readMarker(item: Item, queue: Queue): Marker | undefined {
  const parsed = MARKER_SK.exec(String(item["sk"]));
  if (parsed === null || item["pk"] !== QUEUE_PK[queue]) return undefined;
  const [, orgId, memberId] = parsed;
  if (!ORG_ID.test(String(orgId)) || item["orgId"] !== orgId) return undefined;
  if (queue === "removal") {
    const by = item["by"];
    if (item["developerId"] !== memberId || typeof by !== "string" || by.length === 0) return undefined;
    const removalId = item["removalId"];
    const successorId = item["successorId"];
    // A marker from before this release has no removal id: its time is the one in its key, and its successor is the org's first owner.
    return {
      kind: "removed", orgId: orgId as OrgId, developerId: memberId!, by, removedAt: String(item["sk"]).split("#")[0]!,
      ...(typeof removalId === "string" ? { removalId } : {}), ...(typeof successorId === "string" && MEMBER_ID.test(successorId) ? { successorId } : {}),
    };
  }
  const survivorId = item["survivorId"];
  return item["duplicateId"] === memberId && typeof survivorId === "string" && MEMBER_ID.test(survivorId) && survivorId !== memberId
    ? { kind: "merged", orgId: orgId as OrgId, survivorId, duplicateId: memberId! } : undefined;
}

/**
 * Whether the marker's change really happened (R2-5), and what to do about it. The marker is trusted for where to look, never for what it says.
 * A merge whose duplicate checks out but whose survivor (at the end of its own chain) is no longer a member was followed by that survivor
 * leaving: what the duplicate owned is then a removed member's, and is handled as the duplicate's removal.
 */
type Verdict = { ok: true; kind: "move"; survivorId: string } | { ok: true; kind: "survivor_gone" } | { ok: false; reason: string };

async function verify(deps: LifecycleDeps, marker: Marker): Promise<Verdict> {
  // A removal is always run: a person who has rejoined since still has the cut-off to finish (only the hand-offs are cancelled, in `onMemberRemoved`).
  if (marker.kind === "removed") return { ok: true, kind: "move", survivorId: marker.developerId };
  const { orgId, duplicateId } = marker;
  if ((await deps.signInStore.getDeveloper(duplicateId))?.mergedInto !== marker.survivorId) return { ok: false, reason: "duplicate_not_merged" };
  if (await isMember(deps, orgId, duplicateId)) return { ok: false, reason: "duplicate_still_member" };
  // The survivor may itself have been merged away since: what the duplicate owned goes to the end of that chain, who must be a member.
  const survivorId = await resolveMember(deps, orgId, marker.survivorId);
  return await isMember(deps, orgId, survivorId) ? { ok: true, kind: "move", survivorId } : { ok: true, kind: "survivor_gone" };
}

const recipientsOf = (item: Item): string[] => (Array.isArray(item["recipients"]) ? (item["recipients"] as unknown[]).filter((id): id is string => typeof id === "string") : []);

async function drainQueue(deps: LifecycleDeps, now: number, queue: Queue, cursor?: string, options: { deadline?: number } = {}): Promise<DrainReport> {
  const pk = QUEUE_PK[queue];
  const report = { processed: 0, rejected: 0, failed: 0, skipped: 0 };
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": pk },
    ConsistentRead: true,
    Limit: PAGE,
    ...(cursor === undefined ? {} : { ExclusiveStartKey: { pk, sk: cursor } }),
  })) as { Items?: Item[]; LastEvaluatedKey?: { sk?: unknown } };
  let resumeAfter = cursor;
  const finish = (extra: Partial<DrainReport>): DrainReport => ({
    processed: report.processed, rejected: report.rejected, failed: report.failed, ...(report.skipped > 0 ? { skipped: report.skipped } : {}), ...extra,
  });
  const remove = (item: Item) => deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] } }));
  for (const item of page.Items ?? []) {
    if (options.deadline !== undefined && deps.now() >= options.deadline) {
      return finish({ ...(resumeAfter === undefined ? {} : { next: resumeAfter }), stopped: true });
    }
    resumeAfter = String(item["sk"]);
    const attempts = typeof item["attempts"] === "number" ? item["attempts"] : 0;
    const triedAt = typeof item["lastTriedAt"] === "number" ? item["lastTriedAt"] : 0;
    // A marker that failed waits out its back-off, so the ones behind it are reached.
    if (attempts > 0 && deps.now() < triedAt + backoffMs(attempts)) {
      report.skipped += 1;
      continue;
    }
    const marker = readMarker(item, queue);
    try {
      if (marker === undefined) {
        log(deps, "member_merge.rejected", { reason: "malformed" });
        await remove(item);
        report.rejected += 1;
        continue;
      }
      const verdict = await verify(deps, marker);
      if (!verdict.ok) {
        log(deps, "member_merge.rejected", marker.kind === "merged"
          ? { orgId: marker.orgId, survivorId: marker.survivorId, duplicateId: marker.duplicateId, reason: verdict.reason }
          : { orgId: marker.orgId, developerId: marker.developerId, reason: verdict.reason });
        await remove(item);
        report.rejected += 1;
        continue;
      }
      const ledger = markerLedger(deps, { pk, sk: String(item["sk"]) }, recipientsOf(item));
      if (marker.kind === "removed") {
        await onMemberRemoved(deps, {
          orgId: marker.orgId, developerId: marker.developerId, by: marker.by, removedAt: marker.removedAt, marker: { pk, sk: String(item["sk"]) }, attempts,
          ...(marker.removalId === undefined ? {} : { removalId: marker.removalId }), ...(marker.successorId === undefined ? {} : { successorId: marker.successorId }),
        }, ledger);
      }
      else if (verdict.kind === "survivor_gone") {
        log(deps, "member_merge.survivor_gone", { orgId: marker.orgId, survivorId: marker.survivorId, duplicateId: marker.duplicateId });
        await onMemberRemoved(deps, { orgId: marker.orgId, developerId: marker.duplicateId, by: SYSTEM }, ledger);
      } else await onMembersMerged(deps, { orgId: marker.orgId, survivorId: verdict.survivorId, duplicateId: marker.duplicateId }, ledger);
      await remove(item);
      report.processed += 1;
    } catch (error) {
      report.failed += 1;
      await recordFailure(deps, now, item, marker, attempts + 1, errorName(error));
    }
  }
  const next = page.LastEvaluatedKey?.sk;
  return finish(typeof next === "string" ? { next } : {});
}

/** Notes a failed attempt on the marker (how many, what kind of error, when) so the next sweep can back off; from the 12th it logs `member_merge.parked`. */
async function recordFailure(deps: LifecycleDeps, now: number, item: Item, marker: Marker | undefined, attempts: number, error: string): Promise<void> {
  const who = marker === undefined ? {} : marker.kind === "merged" ? { orgId: marker.orgId, duplicateId: marker.duplicateId } : { orgId: marker.orgId, developerId: marker.developerId };
  log(deps, "member_merge.failed", { ...who, at: new Date(now).toISOString(), attempts, error });
  if (attempts >= PARK_AFTER_ATTEMPTS) log(deps, "member_merge.parked", { level: "error", ...who, attempts, error });
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] },
      UpdateExpression: "SET #attempts = :attempts, #error = :error, #at = :at", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#attempts": "attempts", "#error": "lastError", "#at": "lastTriedAt" },
      ExpressionAttributeValues: { ":attempts": attempts, ":error": error, ":at": deps.now() },
    }));
  } catch (cause) {
    log(deps, "member_merge.attempt_not_kept", { ...who, error: errorName(cause) });
  }
}

/**
 * One page of the merge queue (100 markers, oldest first; `cursor` is the sort key to start after). For each: check the change really
 * happened (the duplicate's record says it was merged into the survivor, the duplicate is no longer a member and the survivor is) and, if it
 * did not, delete the marker with a `member_merge.rejected` line and move nothing; else run the moves and delete the marker. If the survivor
 * has left since, the merge is handled as the duplicate's removal (`member_merge.survivor_gone`). A failure leaves the marker, notes the
 * attempt on it and backs off. `now` is the sweep's clock, for its log lines; `options.deadline` stops the page before the next marker once it has passed.
 */
export function drainMemberMerges(deps: LifecycleDeps, now: number, cursor?: string, options: { deadline?: number } = {}): Promise<DrainReport> {
  return drainQueue(deps, now, "merge", cursor, options);
}

/** The same for the broker-only queue of removals: the person must still not be a member; then the moves run as `onMemberRemoved`. */
export function drainMemberRemovals(deps: LifecycleDeps, now: number, cursor?: string, options: { deadline?: number } = {}): Promise<DrainReport> {
  return drainQueue(deps, now, "removal", cursor, options);
}

export interface DrainRun {
  pages: number;
  processed: number;
  rejected: number;
  failed: number;
  /** Markers left alone this run because an earlier failure's back-off has not passed (absent when none). */
  skipped?: number;
  /** True when the run reached the end of both queues; false when its time ran out. */
  complete: boolean;
}

/**
 * Drains pages of the removal queue, then of the merge queue, until the end or until `budgetMs` has passed. A marker that fails stays where it
 * is, with its attempts noted, and the next run leaves it alone until its back-off is over; within one run each is tried once.
 */
export async function runMemberMergeDrain(deps: LifecycleDeps, options: { budgetMs: number }): Promise<DrainRun> {
  const deadline = deps.now() + options.budgetMs;
  const run: DrainRun = { pages: 0, processed: 0, rejected: 0, failed: 0, complete: false };
  let skipped = 0;
  for (const queue of ["removal", "merge"] as const) {
    let cursor: string | undefined;
    for (;;) {
      if (deps.now() >= deadline) return withSkipped(run, skipped);
      const page = await drainQueue(deps, deps.now(), queue, cursor, { deadline });
      run.pages += 1;
      run.processed += page.processed;
      run.rejected += page.rejected;
      run.failed += page.failed;
      skipped += page.skipped ?? 0;
      if (page.stopped === true) return withSkipped(run, skipped);
      cursor = page.next;
      if (cursor === undefined) break;
    }
  }
  run.complete = true;
  return withSkipped(run, skipped);
}

const withSkipped = (run: DrainRun, skipped: number): DrainRun => (skipped > 0 ? { ...run, skipped } : run);

// ---- a project archive

/**
 * A project was archived. Nothing of Plan 3's changes: a roster change is refused with `PROJECT_ARCHIVED` (`checkRosterChange`), a run of any
 * agent on it is refused as new work (`resolveAgentForTask`), and the project's own agents stay as they are, visible to the people who could
 * see them. This says what the archive left standing, for the log; the runs already going are not stopped (archiving refuses only new work).
 */
export async function onProjectArchived(deps: LifecycleDeps, input: { orgId: OrgId; project: string }): Promise<{ rosterAgents: number; projectAgents: number }> {
  const { orgId, project } = input;
  const [roster, agents] = await Promise.all([queryAll(deps, projectAgentKey(orgId, project, "").pk), deps.store.list(orgId)]);
  const projectAgents = agents.filter((agent) => agent.owner.kind === "project" && agent.owner.project === project).length;
  const result = { rosterAgents: roster.length, projectAgents };
  log(deps, "agents.project_archived", { orgId, project, ...result });
  return result;
}

