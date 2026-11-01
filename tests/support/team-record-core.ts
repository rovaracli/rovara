// Test helpers for the record core (lane "record"): a fake TeamRecord table, a mutable clock, drafts and callers.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { learningModeKey, learningModeLockKey, type OrgId, type RecordSystem, type RetentionMode } from "@agentx/contracts";
import type { AccessReader } from "../../packages/broker/src/team-record/access.js";
import { filterVisible, type FilterDependencies, type FilterResult, type Visible } from "../../packages/broker/src/team-record/acl.js";
import { createRecordSink } from "../../packages/broker/src/team-record/sink.js";
import { tableModeReader } from "../../packages/broker/src/team-record/mode.js";
import { putSourceConfig } from "../../packages/broker/src/team-record/store.js";
import type { IngestDependencies } from "../../packages/broker/src/team-record/ingest.js";
import type { ReadAudience, RecordCaller, RecordDraft, RecordEmbedder, RecordVectorPort, RecordVectorItem, TeamRecordTable } from "../../packages/broker/src/team-record/types.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";

export const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
export const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
export const T0 = Date.parse("2026-10-30T12:00:00.000Z");

export interface World {
  db: FakeDynamoDb;
  table: TeamRecordTable;
  clock: { ms: number };
  deps: IngestDependencies;
  sink: ReturnType<typeof createRecordSink>;
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  vectorItems: RecordVectorItem[];
  vectorDeletes: string[][];
  vectors: RecordVectorPort & { failPut: boolean };
  embedder: RecordEmbedder & { fail: boolean; calls: string[] };
}

export function world(options: Partial<Pick<IngestDependencies, "edition" | "rovaraDefaultRetention">> = {}): World {
  const db = new FakeDynamoDb({ indexKeys: { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } } });
  const table: TeamRecordTable = { documentClient: db, tableName: "TeamRecord" };
  const clock = { ms: T0 };
  const logs: World["logs"] = [];
  const vectorItems: RecordVectorItem[] = [];
  const vectorDeletes: string[][] = [];
  const vectors = {
    dimension: 3, failPut: false,
    async put(items: RecordVectorItem[]) {
      if (this.failPut) return { done: 0, failed: items.map((item) => item.key) };
      vectorItems.push(...items);
      return { done: items.length, failed: [] };
    },
    async delete(keys: string[]) { vectorDeletes.push(keys); return { done: keys.length, failed: [] }; },
  };
  const embedder = {
    fail: false, calls: [] as string[],
    async embed(text: string) { this.calls.push(text); if (this.fail) throw new Error("secret detail from bedrock"); return [0.1, 0.2, 0.3]; },
  };
  const deps: IngestDependencies = {
    table, modes: tableModeReader(table), edition: options.edition ?? "enterprise", rovaraDefaultRetention: options.rovaraDefaultRetention ?? "C",
    embedder, vectors, now: () => clock.ms, log: (event, fields) => { logs.push({ event, fields: { ...fields } }); },
  };
  return { db, table, clock, deps, sink: createRecordSink(deps), logs, vectorItems, vectorDeletes, vectors, embedder };
}

export function setMode(w: World, orgId: OrgId, project: string, mode: string): void {
  w.db.set({ ...learningModeKey(orgId, project), entityType: "TEAM_RECORD_MODE", mode });
}
export function setLock(w: World, orgId: OrgId, mode: string): void {
  w.db.set({ ...learningModeLockKey(orgId), entityType: "TEAM_RECORD_MODE_LOCK", mode });
}

export async function addSource(w: World, input: { orgId?: OrgId; project?: string; source: RecordSystem; scope: string; retention?: RetentionMode; enabled?: boolean; exclude?: string[]; audienceDefault?: "maintainers" | "project"; notesOptIn?: boolean }) {
  return putSourceConfig(w.table, {
    workspaceId: input.orgId ?? ORG_A, project: input.project ?? "web", source: input.source, scope: input.scope, enabled: input.enabled ?? true, retention: input.retention ?? "D",
    exclude: input.exclude ?? [], audienceDefault: input.audienceDefault ?? "maintainers", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z",
    ...(input.notesOptIn === true ? { notesOptIn: true as const } : {}),
  }, { edition: w.deps.edition });
}

export const GITHUB_SCOPE = "github:repo/9";
/** A draft's overrides: a field may be named with `undefined` to drop it, as the tests do for `repo`. */
export type DraftOverrides = { [K in keyof RecordDraft]?: RecordDraft[K] | undefined };
export function githubDraft(extra: DraftOverrides = {}): RecordDraft {
  return {
    workspaceId: ORG_A, project: "web", repo: "acme/api", source: "github", sourceRef: { system: "github.com", id: "c-1", version: "1", url: "https://github.com/acme/api/pull/12#c-1" },
    kind: "github.review_comment", occurredAt: "2026-10-30T10:00:00.000Z", actor: { sourceId: "123", developerId: "dev-1", trust: "member" }, trust: "member",
    audience: { kind: "restricted", acl: { source: "github", scope: GITHUB_SCOPE, principals: ["123"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } },
    text: "Please use withRetry here.", links: ["https://github.com/acme/api/pull/12#c-1"], retention: "D", ...extra,
  } as RecordDraft;
}

export function caller(extra: Partial<RecordCaller> = {}): RecordCaller {
  return { orgId: ORG_A, developerId: "dev-1", projectRole: "contributor", identities: { ids: { github: ["123"] }, groups: {} }, ...extra };
}

export async function get(w: World, key: { pk: string; sk: string }) {
  const response = await w.db.send(new GetCommand({ TableName: "TeamRecord", Key: key })) as { Item?: Record<string, unknown> };
  return response.Item;
}

export const rows = (w: World, entityType: string) => w.db.find((item) => item.entityType === entityType);

/** An access reader that lets every unit through (the tests of the row-level filter and of the rewrites do not exercise the records). */
export const openAccess: AccessReader = {
  async load() { /* nothing to fetch */ },
  get: (scope) => ({ kind: "ok", header: { scope, source: "x", mode: "open", groups: [], liveCheck: "none", modeTs: "1970-01-01T00:00:00.000Z", seeded: true, fed: "events" }, entries: new Map() }),
};
/** `filterVisible` with the open access reader (the row-level rules only). */
export const filterRows = <T extends Visible>(rows: readonly T[], audience: ReadAudience, dependencies: Partial<FilterDependencies> = {}): Promise<FilterResult<T>> => filterVisible(rows, audience, { access: openAccess, ...dependencies });
