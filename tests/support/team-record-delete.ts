// Helpers for the delete and erase tests (lane "record", task D1): a fake lessons port, a recording lake queue and a seeded workspace.
import { recordFactKey, type AuditEventInput, type RecordFact } from "@agentx/contracts";
import { tableLakeDeleteQueue, type LakeDeleteQueue, type LakeDeleteTarget } from "../../packages/broker/src/team-record/lake-queue.js";
import type { LessonDeletionPort, LessonForDeletion } from "../../packages/broker/src/team-record/lesson-fate.js";
import type { PurgeDependencies } from "../../packages/broker/src/team-record/purge.js";
import { putDerivationLinks, putRecordFact, eventFromItem } from "../../packages/broker/src/team-record/store.js";
import { GITHUB_SCOPE, ORG_A, addSource, githubDraft, rows, type World } from "./team-record-core.js";

export const FACT_A = "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a00a1";
export const FACT_B = "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a00b2";

export class FakeLessons implements LessonDeletionPort {
  readonly list: LessonForDeletion[] = [];
  readonly withdrawn: string[] = [];
  readonly trimmed: string[] = [];
  async affected(_org: string, _project: string, deleted: ReadonlySet<string>) {
    return this.list.filter((lesson) => !this.withdrawn.includes(lesson.id) && (lesson.provenance.sourceEvents.some((id) => deleted.has(id)) || lesson.citations.some((c) => c.kind === "record" && deleted.has(c.eventId))));
  }
  async withdraw(_org: string, _project: string, id: string) { this.withdrawn.push(id); }
  async forgetSources(_org: string, _project: string, id: string, deleted: ReadonlySet<string>) {
    this.trimmed.push(id);
    const lesson = this.list.find((entry) => entry.id === id);
    if (lesson !== undefined) lesson.provenance = { sourceEvents: lesson.provenance.sourceEvents.filter((source) => !deleted.has(source)) };
  }
}

export interface DeleteWorld {
  deps: PurgeDependencies;
  lessons: FakeLessons;
  audit: AuditEventInput[];
  lake: LakeDeleteQueue & { enqueued: LakeDeleteTarget[]; rowsAtEnqueue: number[] };
  logs: string[];
}

export function deleteDeps(w: World, extra: Partial<PurgeDependencies> = {}): DeleteWorld {
  const real = tableLakeDeleteQueue(w.table, () => w.clock.ms);
  const enqueued: LakeDeleteTarget[] = [];
  const rowsAtEnqueue: number[] = [];
  const lake = {
    ...real, enqueued, rowsAtEnqueue,
    async enqueue(workspaceId: string, targets: LakeDeleteTarget[]) { enqueued.push(...targets); rowsAtEnqueue.push(rows(w, "TEAM_RECORD_EVENT").length); await real.enqueue(workspaceId, targets); },
  };
  const lessons = new FakeLessons();
  const audit: AuditEventInput[] = [];
  const logs: string[] = [];
  const deps: PurgeDependencies = { table: w.table, vectors: w.vectors, lakeQueue: lake, lessons, audit: async (event) => { audit.push(event); }, now: () => w.clock.ms, log: (event) => { logs.push(event); }, ...extra };
  return { deps, lessons, audit, lake, logs };
}

/** Three github comments in one private scope (dev-1 wrote c-1 and c-2, dev-2 wrote c-3), each with a vector. */
export async function seedComments(w: World, scope = GITHUB_SCOPE) {
  await addSource(w, { source: "github", scope });
  for (const [id, dev] of [["c-1", "dev-1"], ["c-2", "dev-1"], ["c-3", "dev-2"]] as const) {
    await w.sink.put(githubDraft({
      sourceRef: { system: "github.com", id, version: "1" }, actor: { sourceId: dev === "dev-1" ? "123" : "456", developerId: dev, trust: "member" }, links: [],
      audience: { kind: "restricted", acl: { source: "github", scope, principals: ["123", "456"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } }, text: `Comment ${id} about retries.`,
    }));
  }
}

export async function addFact(w: World, id: string, sources: Array<{ system: string; sourceId: string; scope?: string }>, extra: Partial<RecordFact> = {}) {
  await putRecordFact(w.table, { id, workspaceId: ORG_A, project: "web", kind: "decision", text: `Fact ${id.slice(-2)} summary.`, links: [], derivedFrom: sources.map((s) => `${s.system}:${s.sourceId}`), trust: "member", audience: { kind: "project" }, createdAt: "2026-10-30T11:00:00.000Z", ...extra });
  await putDerivationLinks(w.table, { orgId: ORG_A, project: "web", factId: id, sources, at: "2026-10-30T11:00:00.000Z" });
}

export const factKey = (id: string) => recordFactKey(ORG_A, "web", id);
export const idsOf = (w: World) => rows(w, "TEAM_RECORD_EVENT").map((item) => (item.sourceRef as { id: string }).id).sort();
export const eventsOf = (w: World) => rows(w, "TEAM_RECORD_EVENT").flatMap((item) => { const e = eventFromItem(item); return e === undefined ? [] : [e]; });
