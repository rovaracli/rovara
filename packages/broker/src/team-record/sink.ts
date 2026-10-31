// The record sink: the object the source taps call (the ingest lane's `RecordSinkPort`, `SourceConfigPort` and `CaptureModePort`, implemented structurally so no
// lane imports another's files). `put` is the pipeline in ingest.ts. `tombstone` hides at once, then leaves a queue item the delete worker finishes (D1).
// `changePrincipals` and `replaceScopeAudience` keep a private scope's permission snapshot current. A workspace id that is not an org id is refused.
import { OrgIdSchema, recordScopeHash, type OrgId, type RecordSystem, type Audience } from "@agentx/contracts";
import { tableLakeDeleteQueue, type LakeDeleteQueue } from "./lake-queue.js";
import { ingestRecord, type IngestDependencies } from "./ingest.js";
import { captureIsOn } from "./mode.js";
import { DEFAULT_WORK_BUDGET, changeScopePrincipals, queueScopeWork, replaceScopeAudience, tombstoneRows, type WorkBudget } from "./scope-work.js";
import { closeScope, getItemHead } from "./item-head.js";
import { childScopes, getSourceConfigByScope, putScopeWork } from "./store.js";
import type { IngestOutcome, RecordDraft, TombstoneCause } from "./types.js";

export interface RecordSink {
  put(draft: RecordDraft): Promise<IngestOutcome>;
  tombstone(input: { workspaceId: string; system: string; sourceIds?: readonly string[]; scope?: string; cause: TombstoneCause }): Promise<{ hidden: number }>;
  changePrincipals(input: { workspaceId: string; scope: string; add?: readonly string[]; remove?: readonly string[]; at: string }): Promise<void>;
  replaceScopeAudience(input: { workspaceId: string; scope: string; audience: Audience; at: string }): Promise<void>;
}

const CHILD_SCOPES_MAX = 2_000;

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
      // The lake first: a deleted place is queued for the lake before any hot row is touched, so a crash cannot lose it.
      if (input.scope !== undefined) {
        // A place above others covers them: the lake rows carry the CHILD place's hash, so every child with rows or a source row gets its own target, too.
        const below = await childScopes(deps.table, orgId, input.scope, CHILD_SCOPES_MAX);
        if (below.truncated) throw new Error("too many places under that place to list at once");
        await lake.enqueue(orgId, [input.scope, ...below.scopes.slice(0, CHILD_SCOPES_MAX)].map((place) => ({ kind: "scope" as const, hash: recordScopeHash(place) })));
      }
      // A deleted or excluded place stays closed (and so does every place under it): a late message or a backfill is refused. Written first, so a crash cannot reopen it.
      if (input.scope !== undefined && (input.cause === "source_deleted" || input.cause === "excluded")) await closeScope(deps.table, orgId, input.scope, input.cause, new Date((deps.now ?? Date.now)()).toISOString());
      // Chunks of at most 500 source items, each named in the queue BEFORE it is hidden: reads hide what a queue item names, so a crash or a spent budget in the
      // middle of the hide never leaves an item visible.
      const chunks: Array<readonly string[] | undefined> = input.sourceIds === undefined ? [undefined] : Array.from({ length: Math.max(1, Math.ceil(input.sourceIds.length / 500)) }, (_, i) => input.sourceIds!.slice(i * 500, (i + 1) * 500));
      let hidden = 0;
      for (const [index, chunk] of chunks.entries()) {
        const scope = index === 0 ? input.scope : undefined;
        const queued = await queueScopeWork(work, orgId, {
          type: "tombstone", system: input.system, ...(scope === undefined ? {} : { scope }), ...(chunk === undefined ? {} : { sourceIds: [...chunk] }), cause: input.cause, hidePending: true,
        });
        const result = await tombstoneRows(work, orgId, { system: input.system, ...(scope === undefined ? {} : { scope }), ...(chunk === undefined ? {} : { sourceIds: chunk }), cause: input.cause }, budget);
        hidden += result.changed;
        if (result.complete) await putScopeWork(deps.table, orgId, { ...queued, hidePending: false, hidden: result.changed });
        else await putScopeWork(deps.table, orgId, { ...queued, hidden: result.changed });
      }
      const result = { changed: hidden };
      return { hidden: result.changed };
    },

    async changePrincipals(input) {
      const orgId = orgOf(input.workspaceId);
      const result = await changeScopePrincipals(work, orgId, { scope: input.scope, ...(input.add === undefined ? {} : { add: input.add }), ...(input.remove === undefined ? {} : { remove: input.remove }), at: input.at }, budget);
      if (!result.complete) {
        await queueScopeWork(work, orgId, { type: "principals", system: "scope", scope: input.scope, ...(input.add === undefined ? {} : { add: [...input.add] }), ...(input.remove === undefined ? {} : { remove: [...input.remove] }), hidePending: true });
      }
    },

    async replaceScopeAudience(input) {
      const orgId = orgOf(input.workspaceId);
      // A place that turned private: its lake rows still carry the old, wider audience (the lake cannot update it), so they are forgotten.
      if (input.audience.kind === "restricted") await lake.enqueue(orgId, [{ kind: "scope", hash: recordScopeHash(input.scope) }]);
      const result = await replaceScopeAudience(work, orgId, { scope: input.scope, audience: input.audience, at: input.at }, budget);
      if (!result.complete) await queueScopeWork(work, orgId, { type: "audience", system: "scope", scope: input.scope, audience: input.audience, hidePending: true });
    },
  };
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
