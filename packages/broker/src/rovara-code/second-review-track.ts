// Second review (lane cr-settings, switch `cr`): the TRACK RECORD of a model on a company. A task keeps only its latest second opinion, so the history is kept here, as one small row per answered opinion
// (`SECONDREVIEW#TRACK#<model>#<recordedAt>#<task>#<candidate>` in the company's partition of the State table), written from the table's stream and nowhere else: no REVIEW-end, workflow or dispatch code is touched.
//   - A row is created when a task's stored second opinion changes to a new answered one: the model (from the report, which the broker normalised to the planned model), the mode it ran in, and the blocking
//     findings as fingerprints (`workflowFindingFingerprint`, never text), plus whether the first review had already cleared that code.
//   - Outcomes move only from `open`: a finding the NEXT round's second opinion no longer raises is `fixed` (agreed with); one the owner accepted as a risk, or one still standing when the task merged, is `wrong`.
//   - The views are `summarizeSecondReviewTrack` (contracts), so the settings page and the verdict's shadow window count the same rows.
// Everything fails closed: a record that does not parse writes nothing; a row that cannot be read is left alone. Logs carry event names and error names only.
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  OrgIdSchema, SecondOpinionSchema, SecondReviewTrackRowSchema, blockingFindings, orgMetaKey, reviewCleared, secondReviewModelKey, summarizeSecondReviewTrack, workflowFindingFingerprint,
  type OrgId, type SecondReviewTrackRecord, type SecondReviewTrackRow,
} from "@agentx/contracts";
import { z } from "zod";
import type { StreamRecord } from "../developer/notifications.js";
import type { SettingsTable } from "../org/second-review-settings.js";

const TRACK_PREFIX = "SECONDREVIEW#TRACK#";
const orgPk = (orgId: string): string => orgMetaKey(orgId).pk;
const part = (value: string): string => value.replace(/#/gu, "_");
/** Rows of one model, oldest first by time. */
export const trackPrefix = (model: string): string => `${TRACK_PREFIX}${part(model)}#`;
export const trackRowKey = (orgId: string, row: Pick<SecondReviewTrackRow, "model" | "recordedAt" | "taskId" | "candidateDigest">) =>
  ({ pk: orgPk(orgId), sk: `${trackPrefix(row.model)}${row.recordedAt}#${part(row.taskId)}#${row.candidateDigest.slice(0, 16)}` });

const StoredOpinionSchema = z.object({ candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u), opinion: SecondOpinionSchema, recordedAt: z.string().datetime() }).strict();
type StoredOpinion = z.infer<typeof StoredOpinionSchema>;
const opinionOf = (image: Record<string, unknown> | undefined): StoredOpinion | undefined => {
  const parsed = StoredOpinionSchema.safeParse(image?.secondOpinion);
  return parsed.success ? parsed.data : undefined;
};
const answered = (stored: StoredOpinion | undefined): stored is StoredOpinion => stored !== undefined && !stored.opinion.unavailable && stored.opinion.report !== undefined;
const modelOf = (stored: StoredOpinion): string => secondReviewModelKey({ provider: stored.opinion.report!.provider, modelId: stored.opinion.report!.version });
const fingerprintsOf = (stored: StoredOpinion): string[] => blockingFindings(stored.opinion.report!).map((finding) => workflowFindingFingerprint("CRITIC", finding));
const allFingerprintsOf = (stored: StoredOpinion): Set<string> => new Set(stored.opinion.report!.findings.map((finding) => workflowFindingFingerprint("CRITIC", finding)));

interface RowRef { model: string; recordedAt: string; taskId: string; candidateDigest: string }
const refOf = (taskId: string, stored: StoredOpinion): RowRef => ({ model: modelOf(stored), recordedAt: stored.recordedAt, taskId, candidateDigest: stored.candidateDigest });

/** What one change of a task record means for the track record: a row to create, and outcome moves on rows that exist. */
export interface TrackChange {
  create?: SecondReviewTrackRow;
  moves: Array<{ ref: RowRef; to: "fixed" | "wrong"; /** Only these findings (all of the row's open findings when absent). */ only?: ReadonlySet<string>; /** Only the findings NOT in this set (the ones the next round no longer raised). */ except?: ReadonlySet<string> }>;
}

const acceptedKeys = (image: Record<string, unknown> | undefined): Set<string> => {
  const workflow = image?.workflow as { acceptedFindings?: Array<{ candidateDigest?: unknown; role?: unknown; fingerprint?: unknown }> } | undefined;
  return new Set((workflow?.acceptedFindings ?? []).filter((entry) => entry.role === "CRITIC" && typeof entry.candidateDigest === "string" && typeof entry.fingerprint === "string").map((entry) => `${String(entry.candidateDigest)}|${String(entry.fingerprint)}`));
};

/**
 * Pure: the change a task record's update makes to the track record. `previous` is undefined for a first insert. Nothing here reads a store.
 */
export function trackChangeOf(previous: Record<string, unknown> | undefined, next: Record<string, unknown>): TrackChange {
  const change: TrackChange = { moves: [] };
  if (next.entityType !== "DEVELOPER_TASK" || typeof next.taskId !== "string" || !/^[A-Za-z0-9-]{1,64}$/u.test(next.taskId)) return change;
  const taskId = next.taskId;
  const was = opinionOf(previous), now = opinionOf(next);
  const nextWorkflow = next.workflow as { reviews?: unknown[]; acceptedFindings?: unknown[]; stage?: unknown } | undefined;
  if (answered(now) && (was === undefined || was.candidateDigest !== now.candidateDigest || was.recordedAt !== now.recordedAt)) {
    const reviews = Array.isArray(nextWorkflow?.reviews) ? nextWorkflow.reviews as Array<{ role?: string; candidateDigest?: string; status?: string; findings?: unknown[] }> : [];
    const accepted = (nextWorkflow?.acceptedFindings ?? []) as Array<{ candidateDigest: string; role: string; fingerprint: string }>;
    const firstCleared = reviews.some((review) => review.role === "CRITIC" && review.candidateDigest === now.candidateDigest
      && (() => { try { return reviewCleared(review as never, accepted); } catch { return false; } })());
    const row = SecondReviewTrackRowSchema.safeParse({
      model: modelOf(now), mode: now.opinion.mode, taskId, project: typeof next.project === "string" ? next.project : "", candidateDigest: now.candidateDigest, recordedAt: now.recordedAt, firstCleared,
      findings: fingerprintsOf(now).map((fp) => ({ fp, outcome: "open" as const })), rev: 0,
    });
    if (row.success) change.create = row.data;
    // A new round: the findings of the earlier code that this round no longer raises were fixed.
    if (answered(was) && was.candidateDigest !== now.candidateDigest) change.moves.push({ ref: refOf(taskId, was), to: "fixed", except: allFingerprintsOf(now) });
  }
  // Findings the owner accepted as risks since the last update, for the code the task holds: not agreed with.
  if (answered(now)) {
    const before = acceptedKeys(previous);
    const fresh = [...acceptedKeys(next)].filter((key) => !before.has(key) && key.startsWith(`${now.candidateDigest}|`)).map((key) => key.split("|")[1]!);
    if (fresh.length > 0) change.moves.push({ ref: refOf(taskId, now), to: "wrong", only: new Set(fresh) });
    // Merged with findings still standing: not agreed with either.
    const merged = nextWorkflow?.stage === "MERGED" && (previous?.workflow as { stage?: unknown } | undefined)?.stage !== "MERGED";
    if (merged) change.moves.push({ ref: refOf(taskId, now), to: "wrong" });
  }
  return change;
}

export interface TrackStore {
  get(key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined>;
  /** Created only if absent (a replayed record writes nothing twice). */
  create(item: Record<string, unknown>): Promise<void>;
  /** Replaces the findings only if the row is still at `rev`; false: it moved, and nothing was written. */
  move(key: { pk: string; sk: string }, findings: SecondReviewTrackRow["findings"], rev: number): Promise<boolean>;
}

export function trackStoreOf(table: SettingsTable): TrackStore {
  const send = (command: unknown) => table.documentClient.send(command);
  return {
    async get(key) { return (await send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item; },
    async create(item) {
      try { await send(new PutCommand({ TableName: table.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" })); } catch (error) { if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error; }
    },
    async move(key, findings, rev) {
      try {
        await send(new UpdateCommand({ TableName: table.tableName, Key: key, UpdateExpression: "SET findings = :f, rev = :next", ConditionExpression: "rev = :rev", ExpressionAttributeValues: { ":f": findings, ":rev": rev, ":next": rev + 1 } }));
        return true;
      } catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false; throw error; }
    },
  };
}

const rowOf = (item: Record<string, unknown> | undefined): SecondReviewTrackRow | undefined => {
  if (item === undefined) return undefined;
  const { pk: _pk, sk: _sk, entityType: _entityType, orgId: _orgId, ...rest } = item;
  void _pk; void _sk; void _entityType; void _orgId;
  const parsed = SecondReviewTrackRowSchema.safeParse(rest);
  return parsed.success ? parsed.data : undefined;
};

/** Applies the change to the store. A move is retried once if the row moved under it; a missing or unreadable row is left alone. */
export async function applyTrackChange(store: TrackStore, orgId: string, change: TrackChange): Promise<{ created: number; moved: number }> {
  let created = 0, moved = 0;
  if (change.create !== undefined) { await store.create({ ...trackRowKey(orgId, change.create), entityType: "SECOND_REVIEW_TRACK", orgId, ...change.create }); created += 1; }
  for (const move of change.moves) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const key = trackRowKey(orgId, move.ref);
      const row = rowOf(await store.get(key));
      if (row === undefined) break;
      const findings = row.findings.map((finding) => (finding.outcome === "open" && (move.only === undefined || move.only.has(finding.fp)) && (move.except === undefined || !move.except.has(finding.fp)) ? { ...finding, outcome: move.to } : finding));
      if (findings.every((finding, index) => finding.outcome === row.findings[index]!.outcome)) break;
      if (await store.move(key, findings, row.rev)) { moved += 1; break; }
    }
  }
  return { created, moved };
}

/** The stream handler: every task record that changes a second opinion's story. Best effort and bounded; it never fails the batch. */
export async function indexSecondReviewTrack(records: readonly StreamRecord[], store: TrackStore, log: (entry: Record<string, unknown>) => void, fallbackOrg: OrgId): Promise<{ created: number; moved: number; failed: number }> {
  const total = { created: 0, moved: 0, failed: 0 };
  for (const entry of records) {
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    try {
      const next = unmarshall(image) as Record<string, unknown>;
      if (next.entityType !== "DEVELOPER_TASK" || next.secondOpinion === undefined) continue;
      const previous = entry.dynamodb?.OldImage === undefined ? undefined : unmarshall(entry.dynamodb.OldImage) as Record<string, unknown>;
      const change = trackChangeOf(previous, next);
      if (change.create === undefined && change.moves.length === 0) continue;
      const org = OrgIdSchema.safeParse(next.orgId);
      const result = await applyTrackChange(store, org.success ? org.data : fallbackOrg, change);
      total.created += result.created; total.moved += result.moved;
    } catch (error) {
      total.failed += 1;
      log({ event: "second_review_track.write_failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return total;
}

/** Every row of one model on a company (bounded: at most 20 pages of 100). A page that cannot be read fails the read, never a partial count. */
export async function readTrackRows(table: SettingsTable, orgId: string, model: string): Promise<SecondReviewTrackRow[]> {
  const rows: SecondReviewTrackRow[] = [];
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < 20; page += 1) {
    const response = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true, Limit: 100, ExpressionAttributeValues: { ":pk": orgPk(orgId), ":p": trackPrefix(model) },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) { const row = rowOf(item); if (row !== undefined && row.model === model) rows.push(row); }
    if (response.LastEvaluatedKey === undefined) return rows;
    start = response.LastEvaluatedKey;
  }
  throw new Error("too many track rows to read");
}

/** The track record of a model on a company, optionally for a window of dates. */
export async function readTrackRecord(table: SettingsTable, orgId: string, model: string, window?: { from: string; to: string }): Promise<SecondReviewTrackRecord> {
  return summarizeSecondReviewTrack(model, await readTrackRows(table, orgId, model), window);
}
