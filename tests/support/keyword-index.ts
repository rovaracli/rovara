// Helpers for the keyword index tests (lanes K2/K3): rows written straight into the fake table (no ingest), a clock, and the index's own state read back.
import { RecordEventSchema, type RecordEvent } from "@agentx/cloud-contracts";
import { deterministicEventId, eventItem, eventFromItem, type StoredEvent } from "../../packages/broker/src/team-record/store.js";
import { KWIDX_MANIFEST_SK, SegmentCache, maintainProject, type KeywordIndexDeps, type Manifest } from "../../packages/broker/src/team-record/keyword-index.js";
import { SegmentReader } from "../../packages/broker/src/team-record/keyword-index-segment.js";
import { teamRecordPk, type OrgId } from "@rovara-code/contracts";
import { ORG_A, type World } from "./team-record-core.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface RowInput {
  text?: string | undefined;
  structured?: Record<string, string | number | boolean> | undefined;
  /** Epoch ms (default: one minute apart from the clock's start, oldest first). */
  at?: number | undefined;
  org?: OrgId | undefined;
  project?: string | undefined;
  id?: string | undefined;
  restricted?: boolean | undefined;
  /** Seconds from the row's own time (default 30 days for text under retention C). */
  textExpiresAt?: number | undefined;
  hotExpiresAt?: number | undefined;
  kind?: RecordEvent["kind"] | undefined;
}

export function rowOf(w: World, index: number, input: RowInput = {}): RecordEvent {
  const org = input.org ?? ORG_A;
  const at = input.at ?? Date.parse("2026-10-01T00:00:00.000Z") + index * 60_000;
  const id = input.id ?? deterministicEventId(org, "github", "github.com", `row-${String(index)}`, "1");
  return RecordEventSchema.parse({
    id, workspaceId: org, project: input.project ?? "web", source: "github", sourceRef: { system: "github.com", id: `row-${String(index)}`, version: "1" }, scope: "github:repo/9",
    kind: input.kind ?? "github.review_comment", occurredAt: new Date(at).toISOString(), actor: { sourceId: "900", developerId: "dev-filler", trust: "member" }, trust: "member",
    audience: input.restricted === true ? { kind: "restricted", acl: { source: "github", scope: "github:repo/9", principals: ["999"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } } : { kind: "project" },
    ...(input.text === undefined ? {} : { text: input.text }), ...(input.structured === undefined ? {} : { structured: input.structured }), links: [],
    retention: input.textExpiresAt === undefined ? "D" : "C", ...(input.text !== undefined && input.textExpiresAt !== undefined ? { textExpiresAt: input.textExpiresAt } : {}),
    hotExpiresAt: input.hotExpiresAt ?? Math.floor((at + 90 * DAY) / 1000), indexExpiresAt: Math.floor((at + 120 * DAY) / 1000),
  });
}

/** Writes rows straight into the table (no ingest, no late markers). */
export function seedRows(w: World, rows: readonly RecordEvent[]): void {
  for (const row of rows) w.db.set(eventItem(row));
}

export const depsOf = (w: World, cache: SegmentCache = new SegmentCache()): KeywordIndexDeps => ({ table: w.table, now: () => w.clock.ms, log: (event, fields) => { w.logs.push({ event, fields: { ...fields } }); }, cache });

/** Runs maintenance passes until nothing is left to do (a build, a seal, a merge), at most `rounds`. */
export async function buildIndex(w: World, project = "web", orgId: OrgId = ORG_A, options: { expiry?: boolean; rounds?: number; cache?: SegmentCache } = {}): Promise<void> {
  const deps = depsOf(w, options.cache);
  for (let round = 0; round < (options.rounds ?? 30); round += 1) {
    const done = await maintainProject(deps, orgId, project, { deadlineAt: w.clock.ms + 10 * 60_000, ...(options.expiry === true ? { expiry: true } : {}) });
    if (!done.more && done.rebuilt === 0 && done.sealed === 0 && done.merged === 0) return;
  }
}

export function manifestOf(w: World, orgId: OrgId = ORG_A, project = "web"): Manifest | undefined {
  const item = w.db.get({ pk: teamRecordPk(orgId, project), sk: KWIDX_MANIFEST_SK });
  return item === undefined ? undefined : (item as unknown as Manifest);
}

/** Every segment of a project as stored (read from the chunk items). */
export function segmentsOf(w: World, orgId: OrgId = ORG_A, project = "web"): SegmentReader[] {
  const manifest = manifestOf(w, orgId, project);
  if (manifest === undefined) return [];
  return manifest.segments.map((entry) => {
    const parts = Array.from({ length: entry.chunks }, (_unused, n) => w.db.get({ pk: teamRecordPk(orgId, project), sk: `KWIDX#S#${entry.id}#${String(n).padStart(5, "0")}` })?.data as Uint8Array);
    return new SegmentReader(Buffer.concat(parts));
  });
}

/** Every term of every chunk item in the table under a company (manifest-listed or not): what an erase proof must search. */
export function allIndexTerms(w: World, orgId: OrgId = ORG_A): Set<string> {
  const terms = new Set<string>();
  for (const item of w.db.find((entry) => typeof entry.sk === "string" && entry.sk.startsWith("KWIDX#S#") && typeof entry.pk === "string" && entry.pk.startsWith(`WS#${orgId}#`))) {
    // a chunk alone is not a segment: look for the word in the raw bytes
    terms.add(Buffer.from(item.data as Uint8Array).toString("latin1"));
  }
  return terms;
}

/** True when `word` occurs in any chunk's bytes of the company (a word that left the index occurs in none). */
export const indexHoldsWord = (w: World, word: string, orgId: OrgId = ORG_A): boolean => [...allIndexTerms(w, orgId)].some((bytes) => bytes.includes(word));

export const eventsInTable = (w: World): StoredEvent[] => w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT").flatMap((item) => { const event = eventFromItem(item, Math.floor(w.clock.ms / 1000)); return event === undefined ? [] : [event]; });

/** True for the table write that stores a segment chunk (a transaction that checks the build's intent and puts the chunk). */
export function isChunkWrite(command: unknown): boolean {
  const typed = command as { constructor: { name: string }; input?: { TransactItems?: Array<{ Put?: { Item?: { sk?: string } } }> } };
  return typed.constructor.name === "TransactWriteCommand" && (typed.input?.TransactItems ?? []).some((entry) => String(entry.Put?.Item?.sk).startsWith("KWIDX#S#"));
}
