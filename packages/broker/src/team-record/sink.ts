// The record sink: the object the source taps call (the ingest lane's `RecordSinkPort`, `SourceConfigPort` and `CaptureModePort`, implemented structurally so no
// lane imports another's files). `put` is the pipeline in ingest.ts. `tombstone` hides at once, then leaves a queue item the delete worker finishes (D1).
// `changePrincipals` and `replaceScopeAudience` keep a private scope's permission snapshot current. A workspace id that is not an org id is refused.
import { OrgIdSchema, recordDeleteQueueKey, recordScopeHash, type OrgId, type RecordSystem, type Audience } from "@agentx/contracts";
import { accessIsSeeded, applyAudienceEvent, applyMemberEvents, observeRowAccess } from "./access.js";
import { tableLakeDeleteQueue, type LakeDeleteQueue } from "./lake-queue.js";
import { ingestRecord, type IngestDependencies } from "./ingest.js";
import { captureIsOn } from "./mode.js";
import { DEFAULT_WORK_BUDGET, changeScopePrincipals, queueScopeWork, replaceScopeAudience, tombstoneRows, type WorkBudget } from "./scope-work.js";
import { closeScope, getItemHead } from "./item-head.js";
import { childScopes, deleteItem, getSourceConfigByScope, listScopeWork, putScopeWork, type PlaceCursor, type ScopeCursor, type ScopeWork } from "./store.js";
import type { IngestOutcome, RecordDraft, TeamRecordTable, TombstoneCause } from "./types.js";

export interface RecordSink {
  put(draft: RecordDraft): Promise<IngestOutcome>;
  tombstone(input: { workspaceId: string; system: string; sourceIds?: readonly string[]; scope?: string; cause: TombstoneCause }): Promise<{ hidden: number }>;
  changePrincipals(input: { workspaceId: string; scope: string; add?: readonly string[]; remove?: readonly string[]; at: string }): Promise<void>;
  replaceScopeAudience(input: { workspaceId: string; scope: string; audience: Audience; at: string }): Promise<void>;
  /** Seeds the access record of a place from its full, freshly read member list (does nothing if the place is seeded). The tap calls it before the first member event of a place. */
  ensureAccessSeed(input: { workspaceId: string; scope: string; read: () => Promise<Audience | undefined> }): Promise<void>;
}

/** Places listed per page, and how many pages the first call reads before it leaves the rest to the delete worker. */
const CHILD_PAGE = 500;
const CHILD_PAGES_IN_SINK = 4;

export interface SinkOptions {
  budget?: WorkBudget;
  /** Where lake deletes are queued. Default: the TeamRecord table's own queue. */
  lakeQueue?: LakeDeleteQueue;
}

export function createRecordSink(deps: IngestDependencies, options: SinkOptions = {}): RecordSink {
  const budget = options.budget ?? DEFAULT_WORK_BUDGET;
  const work = { table: deps.table, ...(deps.now === undefined ? {} : { now: deps.now }) };
  const orgOf = (workspaceId: string): OrgId => OrgIdSchema.parse(workspaceId);
  const lake = options.lakeQueue ?? tableLakeDeleteQueue(deps.table, deps.now);
  return {
    put: (draft) => ingestRecord(deps, draft),

    async tombstone(input) {
      const orgId = orgOf(input.workspaceId);
      // Chunks of at most 500 source items, each named in the queue BEFORE it is hidden: reads hide what a queue item names, so a crash or a spent budget in the
      // middle of the hide never leaves an item visible.
      const chunks: Array<readonly string[] | undefined> = input.sourceIds === undefined ? [undefined] : Array.from({ length: Math.max(1, Math.ceil(input.sourceIds.length / 500)) }, (_, i) => input.sourceIds!.slice(i * 500, (i + 1) * 500));
      let hidden = 0;
      for (const [index, chunk] of chunks.entries()) {
        const scope = index === 0 ? input.scope : undefined;
        const queued = await queueScopeWork(work, orgId, {
          type: "tombstone", system: input.system, ...(scope === undefined ? {} : { scope }), ...(chunk === undefined ? {} : { sourceIds: [...chunk] }), cause: input.cause, hidePending: true,
          // From the very first write: the children of this place are not queued for the lake yet. A crash anywhere below leaves this standing, so no worker purges a row first.
          ...(scope === undefined ? {} : { childPending: true }),
        });
        // The queue item above is the FIRST write: it already hides the place and everything under it from every read, so a crash at any later call leaves nothing searchable and
        // the delete worker finishes the rest (it closes the place and queues the lake targets too). A deleted or excluded place stays closed, and so does every place under it.
        if (scope !== undefined && (input.cause === "source_deleted" || input.cause === "excluded")) await closeScope(deps.table, orgId, scope, input.cause, new Date((deps.now ?? Date.now)()).toISOString());
        // The lake first: the place is queued for the lake before any hot row is touched, so a crash cannot lose it.
        if (scope !== undefined) await lake.enqueue(orgId, [{ kind: "scope", hash: recordScopeHash(scope) }]);
        // The places below get their own lake targets, a few pages here (the rest are
        // queued by the delete worker from the cursor kept on the item): a place with thousands of places under it never makes the delete fail.
        let childCursor: PlaceCursor | undefined;
        if (scope !== undefined) {
          let pages = 0;
          do {
            const page = await childScopes(deps.table, orgId, scope, { limit: CHILD_PAGE, ...(childCursor === undefined ? {} : { cursor: childCursor }) });
            if (page.scopes.length > 0) await lake.enqueue(orgId, page.scopes.map((place) => ({ kind: "scope" as const, hash: recordScopeHash(place) })));
            childCursor = page.cursor;
            pages += 1;
          } while (childCursor !== undefined && pages < CHILD_PAGES_IN_SINK);
        }
        const result = await tombstoneRows(work, orgId, { system: input.system, ...(scope === undefined ? {} : { scope }), ...(chunk === undefined ? {} : { sourceIds: chunk }), cause: input.cause }, budget);
        hidden += result.changed;
        await putScopeWork(deps.table, orgId, {
          ...queued, hidden: result.changed, hidePending: !result.complete, hideDone: result.complete, ...(scope === undefined ? {} : { childPending: childCursor !== undefined }),
          ...(result.cursor === undefined ? {} : { hideCursor: result.cursor }), ...(childCursor === undefined ? {} : { childCursor }),
        });
      }
      const result = { changed: hidden };
      return { hidden: result.changed };
    },

    async changePrincipals(input) {
      const orgId = orgOf(input.workspaceId);
      // The access record FIRST: one conditional write per person, with the event's own time. From this write on, reads give a removed person nothing, whatever the rows say.
      // The rows are then brought in line for the people whose event is what the record says now: a late, older event that lost to a newer one rewrites nothing.
      const { applied } = await applyMemberEvents(deps.table, orgId, { scope: input.scope, ...(input.add === undefined ? {} : { add: input.add }), ...(input.remove === undefined ? {} : { remove: input.remove }), at: input.at });
      if (applied.add.length === 0 && applied.remove.length === 0) return;
      const item = { type: "principals" as const, system: "scope", scope: input.scope, ...(applied.add.length === 0 ? {} : { add: applied.add }), ...(applied.remove.length === 0 ? {} : { remove: applied.remove }), changeAt: input.at, hidePending: true };
      // An older change to this place is still waiting (it crashed or ran out of time): this one waits behind it, and the worker replays them oldest first. Never inline over it.
      const behind = await olderChange(deps.table, orgId, input.scope);
      if (behind.waiting) { await queueScopeWork(work, orgId, item, behind.latestAt); return; }
      // Someone LOSING access: the place is hidden from everyone from the first write, for as long as the rows are being rewritten. A crash or a timeout in the pass leaves the item,
      // and the worker finishes it. Someone only joining needs no hiding (stale rows are narrower than intended, never wider).
      const queued = applied.remove.length > 0 ? await queueScopeWork(work, orgId, item) : undefined;
      const result = await changeScopePrincipals(work, orgId, { scope: input.scope, ...(applied.add.length === 0 ? {} : { add: applied.add }), ...(applied.remove.length === 0 ? {} : { remove: applied.remove }), at: input.at }, budget);
      await settle(deps.table, orgId, queued, result, item);
    },

    async ensureAccessSeed(input) {
      // A first member event, before any message (the app's own invite): the source's full member list, read just now, seeds the unit so the record is authoritative from then
      // on. The list is read only when the unit is not seeded yet; if it cannot be read the unit stays an overlay of events.
      const orgId = orgOf(input.workspaceId);
      if (await accessIsSeeded(deps.table, orgId, input.scope)) return;
      const audience = await input.read().catch(() => undefined);
      if (audience?.kind === "restricted" && audience.acl.scope === input.scope) await observeRowAccess(deps.table, orgId, audience.acl);
    },

    async replaceScopeAudience(input) {
      const orgId = orgOf(input.workspaceId);
      await applyAudienceEvent(deps.table, orgId, { scope: input.scope, audience: input.audience, at: input.at }); // the access record first (see changePrincipals)
      const item = { type: "audience" as const, system: "scope", scope: input.scope, audience: input.audience, changeAt: input.at, hidePending: true };
      const behind = await olderChange(deps.table, orgId, input.scope);
      if (behind.waiting) { await queueScopeWork(work, orgId, item, behind.latestAt); return; }
      // The place is hidden from everyone from the first write (a new audience may be narrower), and for as long as the rows are being rewritten.
      const queued = await queueScopeWork(work, orgId, item);
      // A place that turned private: its lake rows still carry the old, wider audience (the lake cannot update it), so they are forgotten.
      if (input.audience.kind === "restricted") await lake.enqueue(orgId, [{ kind: "scope", hash: recordScopeHash(input.scope) }]);
      const result = await replaceScopeAudience(work, orgId, { scope: input.scope, audience: input.audience, at: input.at }, budget);
      await settle(deps.table, orgId, queued, result, item);
    },
  };
}

const OLDER_CHANGES_READ = 500;

/**
 * Is a member or audience change to this place still waiting in the queue? Read before a pass: a later change must not finish inline while an earlier one is stuck, or the
 * worker would replay the earlier one over it. A queue too long to read counts as waiting (fail closed: the change is queued, never applied over a guess).
 */
async function olderChange(table: TeamRecordTable, orgId: OrgId, scope: string): Promise<{ waiting: boolean; latestAt?: string }> {
  const queue = await listScopeWork(table, orgId, OLDER_CHANGES_READ);
  const same = queue.filter((entry) => (entry.type === "principals" || entry.type === "audience") && entry.scope === scope);
  const latestAt = same.reduce<string | undefined>((latest, entry) => (latest === undefined || entry.at > latest ? entry.at : latest), undefined);
  if (same.length === 0) return queue.length >= OLDER_CHANGES_READ ? { waiting: true } : { waiting: false };
  return { waiting: true, ...(latestAt === undefined ? {} : { latestAt }) };
}

/**
 * After a pass over a place's rows: a finished pass takes its queue item away (the place is visible again, with the new audience); an unfinished one keeps it with the cursor
 * (the worker goes on); with no item written first (an add-only change) an unfinished pass writes one now.
 */
async function settle(table: TeamRecordTable, orgId: OrgId, queued: ScopeWork | undefined, result: { complete: boolean; cursor?: ScopeCursor | undefined }, item: Omit<ScopeWork, "requestId" | "at" | "queuedAtSeconds" | "hidden">): Promise<void> {
  if (queued !== undefined) {
    if (result.complete) await deleteItem(table, recordDeleteQueueKey(orgId, queued.at, queued.requestId));
    else await putScopeWork(table, orgId, { ...queued, ...(result.cursor === undefined ? {} : { walkCursor: result.cursor }) });
    return;
  }
  if (!result.complete) await queueScopeWork({ table }, orgId, { ...item, ...(result.cursor === undefined ? {} : { walkCursor: result.cursor }) });
}

/** The adapter for the ingest lane's `SourceConfigPort`: the source row of a scope, in the shape the taps read. */
export function createSourceConfigPort(deps: Pick<IngestDependencies, "table" | "edition">) {
  return {
    async get(workspaceId: string, source: RecordSystem, scope: string) {
      const parsed = OrgIdSchema.safeParse(workspaceId);
      if (!parsed.success) return undefined;
      const config = await getSourceConfigByScope(deps.table, parsed.data, source, scope);
      if (config === undefined) return undefined;
      // Public Slack reads live (A) unless the workspace chose "notes with links"; C and D never apply there (Slack's API terms, owner decision Q4).
      const retention = deps.edition === "public" && source === "slack" && !(config.retention === "B" && config.notesOptIn === true) ? "A" : config.retention;
      return { enabled: config.enabled, retention, exclude: config.exclude, audienceDefault: config.audienceDefault, project: config.project };
    },
  };
}

/** The adapter for the ingest lane's `CaptureModePort`. An id that is not an org, or a mode that cannot be read, is "off". */
export function createCaptureModePort(deps: Pick<IngestDependencies, "modes">) {
  return {
    async captureOn(workspaceId: string, project: string | undefined): Promise<boolean> {
      const parsed = OrgIdSchema.safeParse(workspaceId);
      return parsed.success && captureIsOn(await deps.modes.effectiveMode(parsed.data, project));
    },
  };
}

/**
 * The Slack tap asks "did this workspace opt in to notes with links?" (`notesOptIn`). The answer lives in ONE place, the source row (`SourceConfig.notesOptIn`): the config port
 * above already reads a Public Slack row as live-only (A) unless it is B with the opt-in, so by the time the tap asks, the answer is yes. Wire this as the tap's `notesOptIn`.
 */
export const NOTES_OPT_IN_FROM_SOURCE_ROW = async (): Promise<boolean> => true;

/**
 * The ingest lane's `RecordHistoryPort`: the lowest trust any stored or transient version of the item ever had (kept in the item's head, even after newer versions replaced
 * the text). `undefined` when the item was never seen. A read error throws, and the ticket tap reads that as "outsider" (fail closed).
 */
export function createRecordHistoryPort(deps: Pick<IngestDependencies, "table">) {
  return {
    async lowestTrust(input: { workspaceId: string; source: string; system: string; id: string }) {
      const parsed = OrgIdSchema.safeParse(input.workspaceId);
      if (!parsed.success) return undefined;
      return (await getItemHead(deps.table, parsed.data, input.system, input.id))?.lowestTrust;
    },
  };
}
