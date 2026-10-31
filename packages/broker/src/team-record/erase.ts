// Erase (design 4.4.3, task D1): a person, a project (archive) or a whole workspace (org close) leaves the Team record. These are the functions the v1.2 cleanup
// walks call (`learning/cleanup.ts`, which is not on this branch's base: see the lane report, "Wiring pending"). Each is bounded and resumable: a call does what its
// budget allows and says whether it is complete, and the walk calls again until it is. Hot rows, vectors, facts, lessons and the lake queue follow the same
// privacy order as a source delete (`purgeItems`): the lake first, a row only after its vector.
import { LESSON_SK_PREFIX, RECORD_EVENT_SK_PREFIX, RECORD_FACT_SK_PREFIX, recordActorSourceHash, teamRecordPk, type OrgId } from "@agentx/contracts";
import type { Item } from "../agents/table-writes.js";
import { auditRecordErased } from "./audit.js";
import { tableLakeDeleteQueue } from "./lake-queue.js";
import { addPurge, emptyPurge, purgeItems, type PurgeDependencies, type PurgeResult } from "./purge.js";
import { bySource, byActor, byActorSource, deleteItem, queryPrefix, tombstoneItem } from "./store.js";

export interface EraseBudget {
  /** The most items one call reads and removes. */
  maxItems: number;
}
export const DEFAULT_ERASE_BUDGET: EraseBudget = { maxItems: 2_000 };

export interface EraseResult extends PurgeResult {
  /** The learned lessons, skills, manifests and settings removed with a project or a workspace. */
  other: number;
  complete: boolean;
}

const finish = async (deps: PurgeDependencies, orgId: OrgId, cause: "person_erased" | "project_archived" | "org_closed", occurrence: string, result: EraseResult): Promise<void> => {
  if (!result.complete) return;
  await deps.audit?.(auditRecordErased({ orgId, occurrence, at: new Date((deps.now ?? Date.now)()).toISOString(), cause, rows: result.rows, facts: result.facts, lessons: result.lessonsWithdrawn + result.other, vectors: result.vectors })).catch(() => undefined);
};

/** Who is erased: their developer id, and every source identity they have (a Slack user id, a GitHub numeric id) so rows made before they were mapped go too. */
export interface ErasedPerson {
  developerId?: string;
  identities?: ReadonlyArray<{ system: string; sourceId: string }>;
}

/**
 * A person is erased: every row their actions made is hidden and then deleted with its vector, the facts built from those rows are deleted or re-distilled from the
 * sources that are left, the lessons that rested on them are withdrawn (unless a valid code citation alone supports them), and the lake is told to forget them: by
 * developer id, and by each source identity for rows that never had a developer id. `occurrence` makes the audit event unique (the erase request's id).
 */
export async function erasePerson(deps: PurgeDependencies, orgId: OrgId, who: ErasedPerson, occurrence: string, budget: EraseBudget = DEFAULT_ERASE_BUDGET): Promise<EraseResult> {
  const now = deps.now ?? Date.now;
  const queue = deps.lakeQueue ?? tableLakeDeleteQueue(deps.table, now);
  const identities = (who.identities ?? []).slice(0, 50);
  if (who.developerId === undefined && identities.length === 0) throw new Error("erase: name a developer or a source identity");
  // The lake first: their events and outcomes there are queued before anything hot is touched.
  await queue.enqueue(orgId, [
    ...(who.developerId === undefined ? [] : [{ kind: "actor" as const, developerId: who.developerId }]),
    ...identities.map((identity) => ({ kind: "actor_source" as const, hash: recordActorSourceHash(identity.system, identity.sourceId) })),
  ]);
  const found: { items: Item[]; truncated: boolean } = who.developerId === undefined ? { items: [], truncated: false } : await byActor(deps.table, orgId, who.developerId, budget.maxItems);
  for (const identity of identities) {
    const more = await byActorSource(deps.table, orgId, identity.system, identity.sourceId, budget.maxItems);
    found.items.push(...more.items);
    found.truncated ||= more.truncated;
  }
  const at = new Date(now()).toISOString();
  const rows = [...new Map(found.items.filter((item) => item.entityType === "TEAM_RECORD_EVENT").map((item) => [`${item.pk as string}|${item.sk as string}`, item])).values()];
  for (const row of rows) {
    if (typeof row.pk === "string" && typeof row.sk === "string") await tombstoneItem(deps.table, { pk: row.pk, sk: row.sk }, { at, cause: "person_erased" });
  }
  // The links of facts built from these rows (a row's own source item).
  const links: Item[] = [];
  for (const row of rows) {
    const source = row.sourceRef as { system?: unknown; id?: unknown } | undefined;
    if (typeof source?.system !== "string" || typeof source.id !== "string") continue;
    const sourceItems = await bySource(deps.table, orgId, source.system, source.id, 500);
    for (const item of sourceItems.items) {
      if (item.entityType !== "TEAM_RECORD_DERIVATION") continue;
      if (typeof item.pk === "string" && typeof item.sk === "string") await tombstoneItem(deps.table, { pk: item.pk, sk: item.sk }, { at, cause: "person_erased" });
      links.push(item);
    }
  }
  const purged = await purgeItems(deps, orgId, [...rows, ...links]);
  const result: EraseResult = { ...purged, other: 0, complete: !found.truncated && purged.blocked === 0 };
  await finish(deps, orgId, "person_erased", occurrence, result);
  return result;
}

/** Everything that lives in a project's partition besides rows, derivation links, facts and source settings: the learning lane's lessons, skills, manifests, snapshots and settings. */
const LEARNING_PREFIXES = [LESSON_SK_PREFIX, "SKILL#", "LOAD#", "EVALLOAD#", "SNAPSHOT#", "LESSONSET", "MODE"] as const;
const ALL_PREFIXES = ["SOURCE#", RECORD_EVENT_SK_PREFIX, "DERIV#", RECORD_FACT_SK_PREFIX, ...LEARNING_PREFIXES] as const;
/** The workspace's own items: the delete queue, rate counters, deleted-at-source markers and the company mode lock. (`LAKEDEL#` stays until the lake job has run.) */
const WORKSPACE_PREFIXES = ["DELQ#", "RATE#", "DELETED#", "MODE_LOCK", "VECBUCKET"] as const;

/**
 * A project is archived or a workspace closed: the project's partition is emptied. Its source rows go first, so no tap writes into it again; then rows and facts
 * (with vectors, the lake queue and lessons through `purgeItems`: a fact is deleted, never re-distilled, here), then everything the learning lane keeps there.
 * Each call removes up to the budget; call again until `complete`. `project` undefined is the workspace's project-less partition.
 */
export async function eraseProject(deps: PurgeDependencies, orgId: OrgId, project: string | undefined, cause: "project_archived" | "org_closed", occurrence: string, budget: EraseBudget = DEFAULT_ERASE_BUDGET): Promise<EraseResult> {
  const now = deps.now ?? Date.now;
  const queue = deps.lakeQueue ?? tableLakeDeleteQueue(deps.table, now);
  // The whole partition goes, so nothing is re-distilled from what is left.
  const wiping: PurgeDependencies = { ...deps, redistil: undefined, audit: undefined };
  const pk = teamRecordPk(orgId, project);
  const result: EraseResult = { ...emptyPurge(), other: 0, complete: false };
  let left = budget.maxItems;
  const take = (prefix: string): Promise<{ items: Item[]; truncated: boolean }> => queryPrefix(deps.table, orgId, project, prefix, Math.max(left, 1));
  const removePlain = async (items: readonly Item[]): Promise<void> => {
    for (const item of items) if (typeof item.sk === "string") await deleteItem(deps.table, { pk, sk: item.sk });
  };

  // 1. Sources first: nothing new arrives once they are gone.
  const sources = await take("SOURCE#");
  await removePlain(sources.items);
  left -= sources.items.length;
  result.other += sources.items.length;

  // 2. The lake: the whole project is queued before any hot row goes.
  if (project !== undefined) await queue.enqueue(orgId, [{ kind: "project", project }]);

  // 3. Rows and derivation links, then the facts that have no link left.
  for (const prefix of [RECORD_EVENT_SK_PREFIX, "DERIV#"]) {
    if (left <= 0) break;
    const found = await take(prefix);
    left -= found.items.length;
    const purged = await purgeItems(wiping, orgId, found.items);
    Object.assign(result, addPurge(result, purged), { other: result.other });
  }
  if (left > 0) {
    const facts = await take(RECORD_FACT_SK_PREFIX);
    left -= facts.items.length;
    const keys = facts.items.flatMap((item) => (typeof item.id === "string" ? [`fact:${item.id}`] : []));
    const failed = keys.length === 0 ? [] : deps.vectors === undefined ? keys : await deps.vectors.delete(keys).then((response) => response.failed, () => keys);
    for (const item of facts.items) {
      if (typeof item.sk !== "string") continue;
      if (typeof item.id === "string" && failed.includes(`fact:${item.id}`)) { result.blocked += 1; continue; }
      await deleteItem(deps.table, { pk, sk: item.sk });
      result.facts += 1;
      if (typeof item.id === "string") result.vectors += 1;
    }
  }

  // 4. What the learning lane keeps there.
  const lessonIds = new Set<string>();
  for (const prefix of LEARNING_PREFIXES) {
    if (left <= 0) break;
    const found = await take(prefix);
    left -= found.items.length;
    for (const item of found.items) if (prefix === LESSON_SK_PREFIX && typeof item.id === "string") lessonIds.add(item.id);
    await removePlain(found.items);
    result.other += found.items.length;
  }
  if (lessonIds.size > 0 && project !== undefined) await deps.lessonVectors?.removeAll(orgId, project, [...lessonIds]).catch(() => { result.blocked += 1; });

  // Complete when a fresh look finds nothing left and nothing was blocked.
  let remaining = 0;
  for (const prefix of ALL_PREFIXES) remaining += (await queryPrefix(deps.table, orgId, project, prefix, 1)).items.length;
  result.complete = remaining === 0 && result.blocked === 0;
  await finish(deps, orgId, cause, occurrence, result);
  return result;
}

/**
 * A workspace is closed: every project's partition and the workspace's own (the delete queue, rate counters, markers, the mode lock) are emptied. `projects` is the
 * org's project list (the catalog the org close already walks); the project-less partition is always included. The lake queue is left until the lake job has run.
 */
export async function eraseWorkspace(deps: PurgeDependencies, orgId: OrgId, projects: readonly string[], occurrence: string, budget: EraseBudget = DEFAULT_ERASE_BUDGET): Promise<EraseResult & { remainingProjects: string[] }> {
  const total: EraseResult = { ...emptyPurge(), other: 0, complete: true };
  let left = budget.maxItems;
  const remainingProjects: string[] = [];
  for (const project of [...projects, undefined]) {
    if (left <= 0) { if (project !== undefined) remainingProjects.push(project); total.complete = false; continue; }
    const done = await eraseProject({ ...deps, audit: undefined }, orgId, project, "org_closed", occurrence, { maxItems: left });
    left -= done.rows + done.facts + done.other + 1;
    Object.assign(total, addPurge(total, done), { other: total.other + done.other, complete: total.complete && done.complete });
    if (!done.complete && project !== undefined) remainingProjects.push(project);
  }
  if (total.complete) {
    for (const prefix of WORKSPACE_PREFIXES) {
      const own = await queryPrefix(deps.table, orgId, undefined, prefix, 500);
      for (const item of own.items) if (typeof item.sk === "string") await deleteItem(deps.table, { pk: teamRecordPk(orgId), sk: item.sk });
      total.other += own.items.length;
      if (own.truncated) total.complete = false;
    }
  }
  const result = { ...total, remainingProjects };
  await finish(deps, orgId, "org_closed", occurrence, result);
  return result;
}
