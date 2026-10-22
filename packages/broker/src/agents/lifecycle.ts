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
import { DeleteCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  BUILTIN_AGENT_IDS, MEMBER_MERGE_QUEUE_PK, orgMemberKey, orgPk, projectAgentKey,
  type AgentId, type AgentPrincipal, type OrgId,
} from "@agentx/contracts";
import type { MemberRemovalHook } from "../org/store.js";
import { checkOwnerBudget } from "../spend/settings.js";
import { resolveSurvivor, type AgentAccessDeps } from "./access.js";
import type { MoveCause } from "./store.js";

/** What the lifecycle hooks need: the agent routes' own dependencies (`AgentRouteDependencies` is one). */
export interface LifecycleDeps extends AgentAccessDeps {
  now: () => number;
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

/**
 * One kind of thing a member can own or be named on. `merged` hands the duplicate's to the survivor; `removed` hands the removed person's
 * to the successor (or drops it). Both must be repeatable: they run again after a run that stopped half-way. Throwing leaves the marker.
 * A mover that gave something with a budget to someone answers their ids, once any of it moved, so their per-person cap is looked at after
 * every mover has run (see `noteOwnerCap`).
 */
export interface MemberMover {
  /** Names the mover: registering a name again replaces it. */
  name: string;
  merged?(deps: LifecycleDeps, merge: MergedMembers): Promise<void | readonly string[]>;
  removed?(deps: LifecycleDeps, removal: RemovedMember): Promise<void | readonly string[]>;
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
const MARKER_SK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#(org_[0-9a-z]{20})#([a-f0-9]{64})(#removed)?$/;
const PAGE = 100;
const CONFLICT_RETRIES = 3;

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

/**
 * After a move, the new owner's agent budgets may total more than one person may have. Rovara's own move applies at once and counts; what is
 * left is asking an org admin to confirm it.
 *
 * TASK 32 SEAM: Task 32 replaces the log line with an `owner_cap` spend request for an org admin (`ownerBudgetRefusal` in spend/settings.ts is
 * the other half of this seam). Until it exists, the line below is the only trace of it.
 */
async function noteOwnerCap(deps: LifecycleDeps, orgId: OrgId, owner: string, reason: MoveCause["kind"]): Promise<void> {
  try {
    const check = await checkOwnerBudget(deps, { orgId, owner, deltaUsd: 0 });
    if (check.totalUsd > check.capUsd) log(deps, "owner_cap.exceeded_by_move", { orgId, owner, totalUsd: check.totalUsd, capUsd: check.capUsd, reason });
  } catch (error) {
    log(deps, "owner_cap.check_failed", { orgId, owner, reason, error: errorName(error) });
  }
}

/** Member-owned agents of `from` become `to`'s, one `owner_changed` event each. Answers `to` when any moved. */
async function moveAgents(deps: LifecycleDeps, orgId: OrgId, from: string, to: string, cause: MoveCause): Promise<readonly string[]> {
  let moved = 0;
  for (const agent of await deps.store.list(orgId)) {
    if (agent.owner.kind !== "member" || agent.owner.developerId !== from) continue;
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
    await deps.store.skills.moveOwner(orgId, skill.skillId, skill.owner, { kind: "member", developerId: to });
  }
}

/** Shares naming `from` become `to`'s, or are dropped when there is no `to`. */
async function moveShares(deps: LifecycleDeps, orgId: OrgId, from: string, to: string | undefined, cause: MoveCause): Promise<void> {
  const principal = (developerId: string): AgentPrincipal => ({ kind: "member", developerId });
  for (const agentId of await deps.store.listSharedWith(orgId, principal(from))) {
    await deps.store.reassignShare({ orgId, agentId, from: principal(from), ...(to === undefined ? {} : { to: principal(to) }), by: SYSTEM, cause });
  }
}

/** The accountable maintainer `from` of an agent becomes whoever `replacement` names for its project (a built-in has none). Answers who took over. */
async function moveAccountable(deps: LifecycleDeps, orgId: OrgId, from: string, replacement: (project: string | undefined) => Promise<string>, cause: MoveCause): Promise<readonly string[]> {
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
    await give(agent.agentId, agent.owner.kind === "project" ? agent.owner.project : undefined, async () => (await deps.store.get(orgId, agent.agentId))?.accountable?.developerId);
  }
  for (const builtin of BUILTIN_AGENT_IDS) {
    if ((await deps.store.getBuiltinSettings(orgId, builtin))?.accountable?.developerId !== from) continue;
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
  // A person who is gone keeps no share: it is deleted, not handed to the owner (who already manages what they took over).
  removed: (deps, { orgId, developerId }) => moveShares(deps, orgId, developerId, undefined, { kind: "member_removed", developerId }),
});

registerMemberMover({
  name: "accountable",
  merged: (deps, { orgId, survivorId, duplicateId }) => moveAccountable(deps, orgId, duplicateId, async () => survivorId, { kind: "member_merged", developerId: duplicateId }),
  removed: (deps, { orgId, developerId, successorId }) => moveAccountable(deps, orgId, developerId, async (project) => {
    // Another maintainer of the project by grant, else the first owner of the org.
    if (project !== undefined) {
      for (const row of await deps.projectMembers.list(orgId, project)) {
        if (row.role === "maintainer" && row.source === "grant" && row.developerId !== developerId) return row.developerId;
      }
    }
    return successorId;
  }, { kind: "member_removed", developerId }),
});

/**
 * Runs every registered mover with `run`, each even when another failed; throws the first failure after the last one ran. Answers the people
 * the movers gave budgeted things to.
 */
async function runMovers(deps: LifecycleDeps, event: string, fields: Fields, run: (mover: MemberMover) => Promise<void | readonly string[]> | undefined): Promise<Set<string>> {
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
  if (failures.length > 0) throw failures[0];
  return owners;
}

// ---- merges and removals

/**
 * The duplicate's things become the survivor's: member-owned agents and skills, `accountable` ids, share and share-index items, and whatever
 * other movers are registered (the approvals and spend requests addressed to the duplicate). Repeatable. Then the totals of the agent
 * budgets are rebuilt, because the duplicate's agents were counted under the duplicate until now (Task 28). Who the marker says merged is
 * checked by `drainMemberMerges`, not here.
 */
export async function onMembersMerged(deps: LifecycleDeps, merge: MergedMembers): Promise<void> {
  const failures: unknown[] = [];
  let owners = new Set<string>();
  try {
    owners = await runMovers(deps, "member_merge.mover_failed", { orgId: merge.orgId, duplicateId: merge.duplicateId }, (mover) => mover.merged?.(deps, merge));
  } catch (error) {
    failures.push(error);
  }
  for (const owner of [merge.survivorId, merge.duplicateId]) {
    try {
      await deps.store.rebuildOwnerTotal(merge.orgId, owner);
    } catch (error) {
      failures.push(error);
      log(deps, "member_merge.total_failed", { orgId: merge.orgId, owner, error: errorName(error) });
    }
  }
  if (failures.length > 0) throw failures[0];
  for (const owner of owners) await noteOwnerCap(deps, merge.orgId, owner, "member_merged");
}

/**
 * A member was removed: what they owned moves to the first owner of the org (agents and skills, with one `owner_changed` event naming the
 * removal; their agent budgets count against that owner's total), `accountable` moves to another maintainer of that project by grant, else to
 * that owner, their shares are deleted and whatever other movers are registered re-route. Repeatable. An org with no other owner (a closed one)
 * has nobody to hand anything to: that is logged and nothing moves.
 */
export async function onMemberRemoved(deps: LifecycleDeps, removal: { orgId: OrgId; developerId: string; by: string }): Promise<void> {
  const { orgId, developerId, by } = removal;
  const successorId = await firstOwner(deps, orgId, developerId);
  if (successorId === undefined) {
    log(deps, "member_removed.no_successor", { orgId, developerId });
    return;
  }
  const moved: RemovedMember = { orgId, developerId, by, successorId };
  const owners = await runMovers(deps, "member_removed.mover_failed", { orgId, developerId }, (mover) => mover.removed?.(deps, moved));
  for (const owner of owners) await noteOwnerCap(deps, orgId, owner, "member_removed");
}

/** What `OrgStore.removeMember` calls once a member is removed (and the sweep calls again if it failed). */
export function memberRemovalHook(deps: LifecycleDeps): MemberRemovalHook {
  return { onRemoved: (event) => onMemberRemoved(deps, event) };
}

// ---- the queue

/** What one sweep of the queue did. `next` is where the next page starts; `stopped` says it ran out of time before the end of the page. */
export interface DrainReport {
  processed: number;
  rejected: number;
  failed: number;
  next?: string;
  stopped?: true;
}

type Marker =
  | { kind: "merged"; orgId: OrgId; survivorId: string; duplicateId: string }
  | { kind: "removed"; orgId: OrgId; developerId: string; by: string };

/** A marker as the key and the item say it, or undefined when they do not agree (the org in the key is the org on the item, the ids are ids). */
function readMarker(item: Item): Marker | undefined {
  const parsed = MARKER_SK.exec(String(item["sk"]));
  if (parsed === null) return undefined;
  const [, orgId, memberId, removed] = parsed;
  if (!ORG_ID.test(String(orgId)) || item["orgId"] !== orgId) return undefined;
  if (removed !== undefined) {
    const by = item["by"];
    return item["developerId"] === memberId && typeof by === "string" && by.length > 0 ? { kind: "removed", orgId: orgId as OrgId, developerId: memberId!, by } : undefined;
  }
  const survivorId = item["survivorId"];
  return item["duplicateId"] === memberId && typeof survivorId === "string" && MEMBER_ID.test(survivorId) && survivorId !== memberId
    ? { kind: "merged", orgId: orgId as OrgId, survivorId, duplicateId: memberId! } : undefined;
}

/** Whether the marker's change really happened (R2-5), and who the survivor is now. The marker is trusted for where to look, never for what it says. */
type Verdict = { ok: true; survivorId: string } | { ok: false; reason: string };

async function verify(deps: LifecycleDeps, marker: Marker): Promise<Verdict> {
  if (marker.kind === "removed") {
    return await isMember(deps, marker.orgId, marker.developerId) ? { ok: false, reason: "member_still_in_org" } : { ok: true, survivorId: marker.developerId };
  }
  const { orgId, duplicateId } = marker;
  if ((await deps.signInStore.getDeveloper(duplicateId))?.mergedInto !== marker.survivorId) return { ok: false, reason: "duplicate_not_merged" };
  if (await isMember(deps, orgId, duplicateId)) return { ok: false, reason: "duplicate_still_member" };
  // The survivor may itself have been merged away since: what the duplicate owned goes to the end of that chain, who must be a member.
  const survivorId = await resolveMember(deps, orgId, marker.survivorId);
  return await isMember(deps, orgId, survivorId) ? { ok: true, survivorId } : { ok: false, reason: "survivor_not_member" };
}

/**
 * One page of the merge queue (100 markers, oldest first; `cursor` is the sort key to start after). For each: check the change really
 * happened (a merge: the duplicate's record says it was merged into the survivor, the duplicate is no longer a member and the survivor is;
 * a removal: the person is not a member) and, if it did not, delete the marker with a `member_merge.rejected` line and move nothing; else run
 * the moves and delete the marker. A failure leaves the marker for the next sweep. `now` is the sweep's clock, for its log lines; `options.deadline` stops the page before the next marker once it has passed.
 */
export async function drainMemberMerges(deps: LifecycleDeps, now: number, cursor?: string, options: { deadline?: number } = {}): Promise<DrainReport> {
  const report: DrainReport = { processed: 0, rejected: 0, failed: 0 };
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": MEMBER_MERGE_QUEUE_PK },
    ConsistentRead: true,
    Limit: PAGE,
    ...(cursor === undefined ? {} : { ExclusiveStartKey: { pk: MEMBER_MERGE_QUEUE_PK, sk: cursor } }),
  })) as { Items?: Item[]; LastEvaluatedKey?: { sk?: unknown } };
  let resumeAfter = cursor;
  const remove = (item: Item) => deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] } }));
  for (const item of page.Items ?? []) {
    if (options.deadline !== undefined && deps.now() >= options.deadline) {
      return { ...report, ...(resumeAfter === undefined ? {} : { next: resumeAfter }), stopped: true };
    }
    const marker = readMarker(item);
    try {
      if (marker === undefined) {
        log(deps, "member_merge.rejected", { reason: "malformed" });
        await remove(item);
        report.rejected += 1;
      } else {
        const verdict = await verify(deps, marker);
        if (!verdict.ok) {
          log(deps, "member_merge.rejected", marker.kind === "merged"
            ? { orgId: marker.orgId, survivorId: marker.survivorId, duplicateId: marker.duplicateId, reason: verdict.reason }
            : { orgId: marker.orgId, developerId: marker.developerId, reason: verdict.reason });
          await remove(item);
          report.rejected += 1;
        } else {
          if (marker.kind === "merged") await onMembersMerged(deps, { orgId: marker.orgId, survivorId: verdict.survivorId, duplicateId: marker.duplicateId });
          else await onMemberRemoved(deps, { orgId: marker.orgId, developerId: marker.developerId, by: marker.by });
          await remove(item);
          report.processed += 1;
        }
      }
    } catch (error) {
      report.failed += 1;
      log(deps, "member_merge.failed", { ...(marker === undefined ? {} : { orgId: marker.orgId }), at: new Date(now).toISOString(), error: errorName(error) });
    }
    resumeAfter = String(item["sk"]);
  }
  const next = page.LastEvaluatedKey?.sk;
  return { ...report, ...(typeof next === "string" ? { next } : {}) };
}

export interface DrainRun {
  pages: number;
  processed: number;
  rejected: number;
  failed: number;
  /** True when the run reached the end of the queue; false when its time ran out. */
  complete: boolean;
}

/**
 * Drains pages of the queue until the end or until `budgetMs` has passed. Markers that fail stay where they are and are tried again by the
 * next run; within one run each is tried once, because the next page starts after the last one.
 */
export async function runMemberMergeDrain(deps: LifecycleDeps, options: { budgetMs: number }): Promise<DrainRun> {
  const deadline = deps.now() + options.budgetMs;
  const run: DrainRun = { pages: 0, processed: 0, rejected: 0, failed: 0, complete: false };
  let cursor: string | undefined;
  while (deps.now() < deadline) {
    const page = await drainMemberMerges(deps, deps.now(), cursor, { deadline });
    run.pages += 1;
    run.processed += page.processed;
    run.rejected += page.rejected;
    run.failed += page.failed;
    if (page.stopped === true) return run;
    cursor = page.next;
    if (cursor === undefined) {
      run.complete = true;
      return run;
    }
  }
  return run;
}

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

