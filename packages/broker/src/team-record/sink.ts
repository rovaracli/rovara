// The record sink: the object the source taps call (the ingest lane's `RecordSinkPort`, `SourceConfigPort` and `CaptureModePort`, implemented structurally so no
// lane imports another's files). `put` is the pipeline in ingest.ts. `tombstone` hides at once, then leaves a queue item the delete worker finishes (D1).
// `changePrincipals` and `replaceScopeAudience` keep a private scope's permission snapshot current. A workspace id that is not an org id is refused.
import { OrgIdSchema, type OrgId, type RecordSourceKind, type Audience } from "@agentx/contracts";
import { ingestRecord, type IngestDependencies } from "./ingest.js";
import { captureIsOn } from "./mode.js";
import { DEFAULT_WORK_BUDGET, changeScopePrincipals, queueScopeWork, replaceScopeAudience, tombstoneRows, type WorkBudget } from "./scope-work.js";
import { getSourceConfigByScope } from "./store.js";
import type { IngestOutcome, RecordDraft, TombstoneCause } from "./types.js";

export interface RecordSink {
  put(draft: RecordDraft): Promise<IngestOutcome>;
  tombstone(input: { workspaceId: string; system: string; sourceIds?: readonly string[]; scope?: string; cause: TombstoneCause }): Promise<{ hidden: number }>;
  changePrincipals(input: { workspaceId: string; scope: string; add?: readonly string[]; remove?: readonly string[]; at: string }): Promise<void>;
  replaceScopeAudience(input: { workspaceId: string; scope: string; audience: Audience; at: string }): Promise<void>;
}

export interface SinkOptions {
  budget?: WorkBudget;
}

export function createRecordSink(deps: IngestDependencies, options: SinkOptions = {}): RecordSink {
  const budget = options.budget ?? DEFAULT_WORK_BUDGET;
  const work = { table: deps.table, ...(deps.now === undefined ? {} : { now: deps.now }) };
  const orgOf = (workspaceId: string): OrgId => OrgIdSchema.parse(workspaceId);
  return {
    put: (draft) => ingestRecord(deps, draft),

    async tombstone(input) {
      const orgId = orgOf(input.workspaceId);
      const result = await tombstoneRows(work, orgId, { system: input.system, ...(input.scope === undefined ? {} : { scope: input.scope }), ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds }), cause: input.cause }, budget);
      // The queue item always exists: the delete worker removes the rows, vectors, lake rows and facts. While the hide is unfinished the scope reads as hidden.
      await queueScopeWork(work, orgId, {
        type: "tombstone", system: input.system, ...(input.scope === undefined ? {} : { scope: input.scope }), ...(input.sourceIds === undefined ? {} : { sourceIds: [...input.sourceIds].slice(0, 500) }),
        cause: input.cause, hidePending: !result.complete, hidden: result.changed,
      });
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
      const result = await replaceScopeAudience(work, orgId, { scope: input.scope, audience: input.audience, at: input.at }, budget);
      if (!result.complete) await queueScopeWork(work, orgId, { type: "audience", system: "scope", scope: input.scope, audience: input.audience, hidePending: true });
    },
  };
}

/** The adapter for the ingest lane's `SourceConfigPort`: the source row of a scope, in the shape the taps read. */
export function createSourceConfigPort(deps: Pick<IngestDependencies, "table">) {
  return {
    async get(workspaceId: string, source: RecordSourceKind, scope: string) {
      const parsed = OrgIdSchema.safeParse(workspaceId);
      if (!parsed.success) return undefined;
      const config = await getSourceConfigByScope(deps.table, parsed.data, source, scope);
      if (config === undefined) return undefined;
      return { enabled: config.enabled, retention: config.retention, exclude: config.exclude, audienceDefault: config.audienceDefault, project: config.project };
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
