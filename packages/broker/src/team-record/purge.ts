// Physical deletion of record rows and the things derived from them (design 4.4.3): hot rows, their vectors, the lake rows (by queueing them for the lake job),
// the facts distilled from them (deleted, or re-distilled from the sources that are left), and the lessons that rested on them. Used by the delete worker (a
// source deleted something) and by erase (a person, a project, an org).
//
// Order matters and is the privacy order: the lake delete is queued BEFORE any hot row goes (a crash cannot lose it); a row is removed only after its vector is
// gone (a vector that cannot be deleted keeps its tombstoned row, so the next run knows what to delete). A step that cannot run (no vector port, a failed batch)
// leaves the item blocked and counted, never silently done.
import { createHash } from "node:crypto";
import { type OrgId, type TrustClass } from "@rovara-code/contracts";
import { AudienceSchema, type Audience } from "@agentx/cloud-contracts";
import { recordDerivationKey, recordFactKey, teamRecordSourceHash } from "@agentx/cloud-contracts";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Item } from "../agents/table-writes.js";
import { auditLessonWithdrawn, type RecordAuditSink } from "./audit.js";
import { removalGate } from "./keyword-index.js";
import { tableLakeDeleteQueue, type LakeDeleteQueue, type LakeDeleteTarget } from "./lake-queue.js";
import { lessonFate, type LessonDeletionPort } from "./lesson-fate.js";
import { wasDeletedAtSource, projectOfPk } from "./scope-work.js";
import { putFactClean } from "./fact-write.js";
import { deleteItem, putDerivationLinks } from "./store.js";
import { cleanRecordText } from "./text.js";
import type { RecordLog, RecordVectorPort, TeamRecordTable } from "./types.js";

/** Rebuilds a fact from the sources that are left. Returns the new text, or undefined when it cannot (the fact is then deleted). It has no tools and never sees deleted text. */
export interface RedistilPort {
  redistil(input: { orgId: OrgId; project: string | undefined; remaining: ReadonlyArray<{ system: string; sourceId: string }>; kind: string; trust: TrustClass; audience: Audience }): Promise<{ text: string; links?: string[] } | undefined>;
}

export interface PurgeDependencies {
  table: TeamRecordTable;
  /**
   * The key the erased person's aliases (names, emails, Slack ids) are hashed with before they are kept for 30 days for the Asks (`ask-erased-aliases.ts`); the install derives it from its signing key
   * (`askAliasHashKey`). Without it only the person's label tag is kept, never a raw alias.
   */
  askAliasKey?: string | undefined;
  /** Without it a row with a vector cannot be deleted: it stays tombstoned and counted as blocked. */
  vectors?: RecordVectorPort | undefined;
  lakeQueue?: LakeDeleteQueue | undefined;
  lessons?: LessonDeletionPort | undefined;
  /** The org's project names, for an erase that must cover every project's lessons. Without it (and without `projects` on the person) the lessons step is not done. */
  projects?: { projects(orgId: OrgId): Promise<string[]> } | undefined;
  redistil?: RedistilPort | undefined;
  /** The learning lane's lesson vectors, for a whole-project erase. */
  lessonVectors?: { removeAll(orgId: OrgId, project: string, lessonIds: readonly string[]): Promise<void> } | undefined;
  audit?: RecordAuditSink | undefined;
  /**
   * Enterprise foundations I3: the erasure of the attribution a change request carries (which person asked for it and approved its plan): reference rows cut, descriptions rewritten to
   * "a former member", the person's rows deleted last. Throws when a description could not be rewritten (the step then reports unfinished and the next run repeats it). Absent: the install
   * keeps no attribution (the broker that writes it supplies this; `wiring/enterprise-identity.ts` `attributionErasure`).
   */
  attribution?: { erase(orgId: OrgId, developerId: string): Promise<unknown> } | undefined;
  /**
   * ERASE-NAME-1: the erasure of the name a person chose and the name their sign-in record holds (`developer/erase-name.ts`): the chosen name's State item becomes a tombstone that every reader of a name
   * resolves to "A former member", and the sign-in record's name becomes the placeholder. Throws when the sign-in record could not be cleared (the step then reports unfinished and the next run repeats it).
   * Absent: the install keeps no such names to erase (the broker supplies this).
   */
  names?: { erase(developerId: string): Promise<void> } | undefined;
  now?: (() => number) | undefined;
  log?: RecordLog | undefined;
  /** How long one `purgeItems` call may spend rebuilding keyword-index segments without the rows it is about to delete (default 5 s; lane K3). */
  keywordGateMs?: number | undefined;
}

export interface PurgeResult {
  rows: number;
  facts: number;
  redistilled: number;
  vectors: number;
  lessonsWithdrawn: number;
  lessonsKept: number;
  /** Items left in place because a step they need could not run. The caller leaves its queue item for the next run. */
  blocked: number;
  /** Of the blocked rows, how many wait only for the keyword index to be rebuilt without them (lane K3). Absent: none. */
  indexWaiting?: number;
  /** Of those, how many were in a project whose index gate failed with an error (lane K3; it is logged and alarmed as `record.keyword_index_gate_failed`). Absent: none. */
  indexGateFailed?: number;
}

export const emptyPurge = (): PurgeResult => ({ rows: 0, facts: 0, redistilled: 0, vectors: 0, lessonsWithdrawn: 0, lessonsKept: 0, blocked: 0 });
export const addPurge = (into: PurgeResult, from: PurgeResult): PurgeResult => ({
  rows: into.rows + from.rows, facts: into.facts + from.facts, redistilled: into.redistilled + from.redistilled, vectors: into.vectors + from.vectors,
  lessonsWithdrawn: into.lessonsWithdrawn + from.lessonsWithdrawn, lessonsKept: into.lessonsKept + from.lessonsKept, blocked: into.blocked + from.blocked,
  ...((into.indexWaiting ?? 0) + (from.indexWaiting ?? 0) > 0 ? { indexWaiting: (into.indexWaiting ?? 0) + (from.indexWaiting ?? 0) } : {}),
  ...((into.indexGateFailed ?? 0) + (from.indexGateFailed ?? 0) > 0 ? { indexGateFailed: (into.indexGateFailed ?? 0) + (from.indexGateFailed ?? 0) } : {}),
});

const VECTOR_BATCH = 500;
const eventKey = (id: string): string => `event:${id}`;
const factVectorKey = (id: string): string => `fact:${id}`;

/** `system:sourceId`, split at the first colon: how a fact names a source it was distilled from. */
export function parseSourceRef(ref: string): { system: string; sourceId: string } | undefined {
  const at = ref.indexOf(":");
  return at <= 0 || at === ref.length - 1 ? undefined : { system: ref.slice(0, at), sourceId: ref.slice(at + 1) };
}

async function deleteVectors(deps: PurgeDependencies, keys: readonly string[]): Promise<{ gone: Set<string>; deleted: number }> {
  const gone = new Set<string>();
  let deleted = 0;
  if (keys.length === 0) return { gone, deleted };
  if (deps.vectors === undefined) return { gone, deleted };
  for (let at = 0; at < keys.length; at += VECTOR_BATCH) {
    const batch = keys.slice(at, at + VECTOR_BATCH);
    const failed = await deps.vectors.delete(batch).then((result) => new Set(result.failed), () => new Set(batch));
    for (const key of batch) if (!failed.has(key)) { gone.add(key); deleted += 1; }
  }
  return { gone, deleted };
}

interface FactPlan {
  factId: string;
  project: string | undefined;
  pk: string;
  sk: string;
  refs: Array<{ system: string; sourceId: string }>;
  remaining: Array<{ system: string; sourceId: string; scope?: string; actor?: { developerId?: string; sourceId?: string } }>;
  kind: string;
  trust: TrustClass;
  audience: Audience;
  replacement?: { factId: string; text: string; links: string[] };
}

async function planFact(deps: PurgeDependencies, orgId: OrgId, link: Item): Promise<FactPlan | undefined> {
  if (typeof link.factId !== "string" || typeof link.pk !== "string") return undefined;
  const project = projectOfPk(link.pk);
  const key = recordFactKey(orgId, project, link.factId);
  const response = await deps.table.documentClient.send(new GetCommand({ TableName: deps.table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
  const fact = response.Item;
  if (fact === undefined) return undefined;
  const refs = (Array.isArray(fact.derivedFrom) ? fact.derivedFrom : []).flatMap((ref) => (typeof ref === "string" ? [parseSourceRef(ref)] : [])).flatMap((ref) => (ref === undefined ? [] : [ref]));
  const remaining: FactPlan["remaining"] = [];
  for (const ref of refs) {
    const linkItem = await deps.table.documentClient.send(new GetCommand({ TableName: deps.table.tableName, Key: recordDerivationKey(orgId, project, ref.system, ref.sourceId, link.factId), ConsistentRead: true })) as { Item?: Item };
    const gone = linkItem.Item?.tombstone !== undefined || await wasDeletedAtSource(deps.table, orgId, ref.system, ref.sourceId);
    if (!gone) {
      const item = linkItem.Item;
      const actorDeveloperId = typeof item?.actorDeveloperId === "string" ? item.actorDeveloperId : undefined;
      const actorSourceId = typeof item?.actorSourceId === "string" ? item.actorSourceId : undefined;
      remaining.push({ ...ref, ...(typeof item?.scope === "string" ? { scope: item.scope } : {}), ...(actorDeveloperId === undefined && actorSourceId === undefined ? {} : { actor: { ...(actorDeveloperId === undefined ? {} : { developerId: actorDeveloperId }), ...(actorSourceId === undefined ? {} : { sourceId: actorSourceId }) } }) });
    }
  }
  const audience = AudienceSchema.safeParse(fact.audience);
  const trust = (["outsider", "system", "member", "rovara"] as const).find((candidate) => candidate === fact.trust) ?? "outsider";
  const plan: FactPlan = { factId: link.factId, project, pk: key.pk, sk: key.sk, refs, remaining, kind: typeof fact.kind === "string" ? fact.kind : "fact", trust, audience: audience.success ? audience.data : { kind: "restricted", acl: { source: "rovara", scope: "rovara:deleted", capturedAt: new Date(0).toISOString(), liveCheck: "none" } } };
  if (remaining.length > 0 && deps.redistil !== undefined && audience.success) {
    const made = await deps.redistil.redistil({ orgId, project, remaining: remaining.map(({ system, sourceId }) => ({ system, sourceId })), kind: plan.kind, trust, audience: audience.data }).catch(() => undefined);
    const text = made === undefined ? undefined : cleanRecordText(made.text);
    if (made !== undefined && text !== undefined) {
      const factId = createHash("sha256").update(`${link.factId}\n${remaining.map((ref) => `${ref.system}:${ref.sourceId}`).join("\n")}`).digest("hex");
      plan.replacement = { factId: `${factId.slice(0, 8)}-${factId.slice(8, 12)}-5${factId.slice(13, 16)}-8${factId.slice(17, 20)}-${factId.slice(20, 32)}`, text: text.slice(0, 400), links: made.links ?? [] };
    }
  }
  return plan;
}

/**
 * Deletes the given items (record rows and derivation links, as an index query returns them) and everything derived from them. Each row is hidden already by its
 * tombstone; this removes it for good. Returns what it removed and how many items it had to leave (blocked).
 */
export async function purgeItems(deps: PurgeDependencies, orgId: OrgId, items: readonly Item[], options: { lessonsSettled?: boolean; indexHandled?: boolean } = {}): Promise<PurgeResult> {
  const result = emptyPurge();
  const rows = items.filter((item) => item.entityType === "TEAM_RECORD_EVENT" && typeof item.id === "string" && typeof item.pk === "string" && typeof item.sk === "string");
  const links = items.filter((item) => item.entityType === "TEAM_RECORD_DERIVATION" && typeof item.pk === "string" && typeof item.sk === "string");
  const queue = deps.lakeQueue ?? tableLakeDeleteQueue(deps.table, deps.now);

  // 1. Plan the facts. A fact is planned once however many of its links are in the batch.
  const plans = new Map<string, FactPlan>();
  for (const link of links) {
    if (typeof link.factId !== "string" || plans.has(`${link.pk as string}|${link.factId}`)) continue;
    const plan = await planFact(deps, orgId, link);
    if (plan !== undefined) plans.set(`${link.pk as string}|${link.factId}`, plan);
  }

  // 2. The lake first: the targets are queued before any hot row goes.
  const targets: LakeDeleteTarget[] = [];
  for (const row of rows) {
    const source = row.sourceRef as { system?: unknown; id?: unknown } | undefined;
    if (typeof source?.system === "string" && typeof source.id === "string") targets.push({ kind: "source", sourceHash: teamRecordSourceHash(source.system, source.id) });
  }
  for (const plan of plans.values()) targets.push({ kind: "fact", factId: plan.factId });
  const distinct = [...new Map(targets.map((target) => [JSON.stringify(target), target])).values()];
  if (distinct.length > 0) await queue.enqueue(orgId, distinct);

  // 3. The lessons that rest on what is about to go. This runs BEFORE any hot row is removed: the sources are deleted at their origin whatever the vectors do, so the
  // lessons are settled now, from the ids alone. No lessons port is not "no lessons": the delete is refused (blocked) until a port, even an explicit empty one, is given.
  const planned = new Map<string | undefined, Set<string>>();
  const addPlanned = (project: string | undefined, id: string) => { const set = planned.get(project) ?? new Set<string>(); set.add(id); planned.set(project, set); };
  for (const row of rows) addPlanned(projectOfPk(row.pk as string), row.id as string);
  for (const fact of plans.values()) addPlanned(fact.project, fact.factId);
  const anything = [...planned.values()].some((ids) => ids.size > 0);
  // A person erase has already settled the lessons (hard-deleted or scrubbed them by person), so the source-delete rule must not run again over the same rows.
  if (anything && options.lessonsSettled !== true) {
    try {
      if (deps.lessons === undefined) throw new Error("no lessons port");
      for (const [project, ids] of planned) {
        if (project === undefined || ids.size === 0) continue;
        for (const lesson of await deps.lessons.affected(orgId, project, ids)) {
          const fate = lessonFate(lesson, ids);
          if (fate === "withdraw") {
            await deps.lessons.withdraw(orgId, project, lesson.id, "sources_deleted");
            result.lessonsWithdrawn += 1;
            await deps.audit?.(auditLessonWithdrawn({ orgId, lessonId: lesson.id, version: lesson.version, at: new Date((deps.now ?? Date.now)()).toISOString(), cause: "sources_deleted" })).catch(() => undefined);
          } else if (fate === "keep_without_record_citations") {
            await deps.lessons.forgetSources(orgId, project, lesson.id, ids);
            result.lessonsKept += 1;
          }
        }
      }
    } catch {
      deps.log?.("record.purge_lessons_unavailable", {});
      result.blocked += rows.length + plans.size;
      return result;
    }
  }

  // 3b. The keyword index (lane K3): a row's words leave the index BEFORE the row goes, the same rule as the vector. `removalGate` hides any row not hidden yet, marks the segments that cover the rows dirty, rebuilds them
  // now (within `keywordGateMs`) and names the rows whose words are out. A row it does not name stays, counted as waiting; the 15-minute job rebuilds what is left and the next run deletes the row. A whole-project erase
  // (`indexHandled`) deletes the project's index items itself, first.
  const gate = rows.length === 0 || options.indexHandled === true ? undefined : await removalGate({ table: deps.table, ...(deps.now === undefined ? {} : { now: deps.now }), ...(deps.log === undefined ? {} : { log: deps.log }) }, orgId, rows, { budgetMs: deps.keywordGateMs ?? 5_000 });

  if (gate !== undefined && gate.failed > 0) result.indexGateFailed = gate.failed;

  // 4. Vectors, then the rows and facts whose vectors are gone.
  const vectorKeys = [...rows.map((row) => eventKey(row.id as string)), ...[...plans.values()].map((plan) => factVectorKey(plan.factId))];
  const vectors = await deleteVectors(deps, vectorKeys);
  result.vectors += vectors.deleted;
  
  for (const row of rows) {
    if (!vectors.gone.has(eventKey(row.id as string))) { result.blocked += 1; continue; }
    if (gate !== undefined && !gate.ready.has(`${row.pk as string}|${row.sk as string}`)) { result.blocked += 1; result.indexWaiting = (result.indexWaiting ?? 0) + 1; continue; }
    await deleteItem(deps.table, { pk: row.pk as string, sk: row.sk as string });
    result.rows += 1;
  }
  const settledLinks = new Set<string>();
  for (const plan of plans.values()) {
    if (!vectors.gone.has(factVectorKey(plan.factId))) { result.blocked += 1; continue; }
    if (plan.replacement !== undefined) {
      await putFactClean(deps.table, orgId, {
        id: plan.replacement.factId, workspaceId: orgId, ...(plan.project === undefined ? {} : { project: plan.project }), kind: plan.kind as never, text: plan.replacement.text,
        links: plan.replacement.links.slice(0, 10), derivedFrom: plan.remaining.map((ref) => `${ref.system}:${ref.sourceId}`), trust: plan.trust, audience: plan.audience, createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
      }, plan.remaining.flatMap((ref) => (ref.scope === undefined ? [] : [ref.scope])));
      // The new links keep who wrote each source and its place, so a later person erase or a deleted place still reaches the new fact.
      await putDerivationLinks(deps.table, { orgId, project: plan.project, factId: plan.replacement.factId, sources: plan.remaining, at: new Date((deps.now ?? Date.now)()).toISOString() });
      result.redistilled += 1;
    }
    await deleteItem(deps.table, { pk: plan.pk, sk: plan.sk });
    for (const ref of plan.refs) await deleteItem(deps.table, recordDerivationKey(orgId, plan.project, ref.system, ref.sourceId, plan.factId));
    settledLinks.add(plan.factId);
    result.facts += 1;
  }
  // A link of a fact that no longer exists goes with the batch; one whose fact is blocked stays, so the next run finds the fact again.
  for (const link of links) {
    const exists = typeof link.factId === "string" && plans.has(`${link.pk as string}|${link.factId}`);
    if (!exists || settledLinks.has(link.factId as string)) await deleteItem(deps.table, { pk: link.pk as string, sk: link.sk as string });
  }

  if (result.blocked > 0) deps.log?.("record.purge_blocked", { blocked: result.blocked, ...(result.indexWaiting === undefined ? {} : { indexWaiting: result.indexWaiting }) });
  return result;
}
