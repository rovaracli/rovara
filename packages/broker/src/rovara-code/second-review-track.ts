// Second review (lane cr-settings, switch `cr`): the TRACK RECORD of a model on a company. A task keeps only its latest second opinion, so the history is kept here, as one small row per answered opinion
// (`SECONDREVIEW#TRACK#<model>#<recordedAt>#<task>#<candidate>` in the company's partition of the State table), written from the table's stream and nowhere else: no REVIEW-end, workflow or dispatch code is touched.
//   - A row is created when a task's stored second opinion changes to a new answered one: the model (from the report, which the broker normalised to the planned model), the mode it ran in, and the blocking
//     findings as fingerprints (`workflowFindingFingerprint`, never text), plus whether the first review had already cleared that code.
//   - Outcomes move only from `open`. A finding is `fixed` (agreed with) only when ALL of these hold: the next round was reviewed by the SAME model; that round no longer raises it, matched on a STABLE key (the cited
//     file and the normalised text, never the line number, so a line shift or a change of case and punctuation is the same finding); and the new candidate CHANGED the cited file (a finding that cites no file, or a change
//     the broker cannot see, stays open). One the owner accepted as a risk, or one still standing when the task merged, is `wrong`.
//   - A second opinion run again on the same code REPLACES the earlier row (outcomes already decided are carried over), so one candidate is never counted twice.
//   - Rows expire (`TRACK_RETENTION_DAYS`) and are read by their time window, page by page, so history cannot grow the read without bound.
//   - The views are `summarizeSecondReviewTrack` (contracts), so the settings page and the verdict's shadow window count the same rows.
// Everything fails closed: a record that does not parse writes nothing; a row that cannot be read is left alone. Logs carry event names and error names only.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, SecondOpinionSchema, SecondReviewTrackRowSchema, blockingFindings, reviewCleared, secondReviewModelKey, summarizeSecondReviewTrack, workflowFindingFingerprint, type OrgId, type SecondReviewTrackRecord, type SecondReviewTrackRow } from "@rovara-code/contracts";
import { orgMetaKey } from "@agentx/cloud-contracts";
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

/** The pointer from a task to its latest answered row. (`TRACKLAST#` sorts after every `TRACK#<model>#` range, so a model's window read never meets it.) */
const latestKey = (orgId: string, taskId: string) => ({ pk: orgPk(orgId), sk: `SECONDREVIEW#TRACKLAST#${part(taskId)}` });

const StoredOpinionSchema = z.object({ candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u), opinion: SecondOpinionSchema, recordedAt: z.string().datetime() }).strict();
type StoredOpinion = z.infer<typeof StoredOpinionSchema>;
const opinionOf = (image: Record<string, unknown> | undefined): StoredOpinion | undefined => {
  const parsed = StoredOpinionSchema.safeParse(image?.secondOpinion);
  return parsed.success ? parsed.data : undefined;
};
const answered = (stored: StoredOpinion | undefined): stored is StoredOpinion => stored !== undefined && !stored.opinion.unavailable && stored.opinion.report !== undefined;
const modelOf = (stored: StoredOpinion): string => secondReviewModelKey({ provider: stored.opinion.report!.provider, modelId: stored.opinion.report!.version });

/** Rows are kept this long, then the table's TTL (named environments) removes them. A model's record is read by window, so older history only costs storage. */
export const TRACK_RETENTION_DAYS = 400;
const sha = (...parts: string[]): string => createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
/** A cited file as the rounds compare it: slashes forward, no leading `./`, `a/` or `b/`, lower case. */
const normalFile = (file: string): string => file.trim().replace(/\\/gu, "/").replace(/^(?:\.\/|[ab]\/)+/u, "").toLowerCase();
/** A finding's words as the rounds compare them: lower case, letters and digits only, numbers dropped (they are line numbers and counts), one space between words. */
const normalText = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((word) => word !== "" && !/^\p{N}+$/u.test(word)).join(" ");
/** The stable key of a finding: the file it cites and its normalised text, never the line. */
export const findingKey = (finding: { text: string; file?: string | undefined }): string => sha("finding", finding.file === undefined ? "" : normalFile(finding.file), normalText(finding.text));
/** The hash of a cited file's path, as a row keeps it and as the changed-files port's answer is compared. */
export const fileHash = (file: string): string => sha("file", normalFile(file));
const trackedFindingsOf = (stored: StoredOpinion): SecondReviewTrackRow["findings"] =>
  blockingFindings(stored.opinion.report!).map((finding) => ({ fp: workflowFindingFingerprint("CRITIC", finding), outcome: "open" as const, key: findingKey(finding), ...(finding.file === undefined ? {} : { file: fileHash(finding.file) }) }));
/** Everything the round raises, blocking or not, by exact fingerprint and by stable key: what a finding of the round before must be absent from to count as fixed. */
const raisedBy = (stored: StoredOpinion): Set<string> => new Set(stored.opinion.report!.findings.flatMap((finding) => [workflowFindingFingerprint("CRITIC", finding), findingKey(finding)]));

interface RowRef { model: string; recordedAt: string; taskId: string; candidateDigest: string }
const refOf = (taskId: string, stored: StoredOpinion): RowRef => ({ model: modelOf(stored), recordedAt: stored.recordedAt, taskId, candidateDigest: stored.candidateDigest });

/** What one change of a task record means for the track record: a row to create, and outcome moves on rows that exist. */
export interface TrackChange {
  create?: SecondReviewTrackRow;
  /** The earlier row of the SAME code by the SAME model (a second opinion run again): `create` replaces it, and the outcomes already decided on it are carried over. */
  replaces?: RowRef;
  /** The task merged and its latest opinion gave no answer: its latest ANSWERED row (kept in a pointer) is marked wrong for the findings still standing. */
  mergedTask?: string;
  moves: Array<{
    ref: RowRef; to: "fixed" | "wrong";
    /** Only these findings (all of the row's open findings when absent). */
    only?: ReadonlySet<string>;
    /** Not these findings: the ones the next round still raises, by stable key (or by fingerprint on a row written before keys). */
    except?: ReadonlySet<string>;
    /** `fixed` only: the hashes of the files the new candidate changed. A finding is fixed only if the file it cites is among them; unknown (absent) fixes nothing. */
    changed?: ReadonlySet<string>;
  }>;
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
      findings: trackedFindingsOf(now), rev: 0,
    });
    if (row.success) change.create = row.data;
    const sameModel = answered(was) && modelOf(was) === modelOf(now);
    // The same code reviewed again by the same model: one candidate is one row.
    if (row.success && answered(was) && sameModel && was.candidateDigest === now.candidateDigest) change.replaces = refOf(taskId, was);
    // A new round by the SAME model: the findings of the earlier code that this round no longer raises (by stable key) were fixed, if the new code changed the file they cite. Another model's silence says nothing.
    if (answered(was) && sameModel && was.candidateDigest !== now.candidateDigest) change.moves.push({ ref: refOf(taskId, was), to: "fixed", except: raisedBy(now) });
  }
  // Merged with findings still standing: not agreed with either.
  const merged = nextWorkflow?.stage === "MERGED" && (previous?.workflow as { stage?: unknown } | undefined)?.stage !== "MERGED";
  // Findings the owner accepted as risks since the last update, for the code the task holds: not agreed with.
  if (answered(now)) {
    const before = acceptedKeys(previous);
    const fresh = [...acceptedKeys(next)].filter((key) => !before.has(key) && key.startsWith(`${now.candidateDigest}|`)).map((key) => key.split("|")[1]!);
    if (fresh.length > 0) change.moves.push({ ref: refOf(taskId, now), to: "wrong", only: new Set(fresh) });
    if (merged) change.moves.push({ ref: refOf(taskId, now), to: "wrong" });
  } else if (merged && now !== undefined) {
    // The latest opinion is one that gave no answer (a re-run failed): the findings that stand are those of the latest row that did.
    change.mergedTask = taskId;
  }
  return change;
}

export interface TrackStore {
  get(key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined>;
  /** Created only if absent (a replayed record writes nothing twice). */
  create(item: Record<string, unknown>): Promise<void>;
  /** Deletes a row (the earlier row a re-run replaced). Deleting a missing row is not an error. */
  remove(key: { pk: string; sk: string }): Promise<void>;
  /** Points a task at its latest answered row, unless the pointer already names a later one. */
  setLatest(item: Record<string, unknown>): Promise<void>;
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
    async setLatest(item) {
      try {
        await send(new PutCommand({ TableName: table.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk) OR recordedAt < :r", ExpressionAttributeValues: { ":r": item.recordedAt } }));
      } catch (error) { if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error; }
    },
    async remove(key) { await send(new DeleteCommand({ TableName: table.tableName, Key: key })); },
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
  const { pk: _pk, sk: _sk, entityType: _entityType, orgId: _orgId, [INDEX_EXPIRY_ATTRIBUTE]: _expires, ...rest } = item;
  void _pk; void _sk; void _entityType; void _orgId; void _expires;
  const parsed = SecondReviewTrackRowSchema.safeParse(rest);
  return parsed.success ? parsed.data : undefined;
};

const expiryOf = (recordedAt: string): number => Math.floor(Date.parse(recordedAt) / 1000) + TRACK_RETENTION_DAYS * 86_400;
const raisedAgain = (finding: SecondReviewTrackRow["findings"][number], except: ReadonlySet<string> | undefined): boolean =>
  except !== undefined && except.has(finding.key ?? finding.fp);

/** Applies the change to the store. A move is retried once if the row moved under it; a missing or unreadable row is left alone. */
export async function applyTrackChange(store: TrackStore, orgId: string, change: TrackChange): Promise<{ created: number; moved: number }> {
  let created = 0, moved = 0;
  if (change.create !== undefined) {
    let row = change.create;
    const replaced = change.replaces === undefined ? undefined : trackRowKey(orgId, change.replaces);
    const newKey = trackRowKey(orgId, row);
    if (replaced !== undefined && replaced.sk !== newKey.sk) {
      // The same code reviewed again: what was already decided about a finding stays decided, including a finding this run does not raise again.
      const earlier = rowOf(await store.get(replaced));
      if (earlier !== undefined) {
        const same = (left: SecondReviewTrackRow["findings"][number], right: SecondReviewTrackRow["findings"][number]): boolean => (left.key !== undefined && right.key !== undefined ? left.key === right.key : left.fp === right.fp);
        const decided = earlier.findings.filter((old) => old.outcome !== "open");
        const merged = row.findings.map((finding) => { const found = decided.find((old) => same(old, finding)); return found === undefined ? finding : { ...finding, outcome: found.outcome }; });
        const kept = decided.filter((old) => !row.findings.some((finding) => same(old, finding)));
        // Decided findings are never the ones dropped to stay within the row's size.
        row = { ...row, findings: [...merged.slice(0, Math.max(0, 20 - kept.length)), ...kept].slice(0, 20) };
      }
    }
    await store.create({ ...newKey, entityType: "SECOND_REVIEW_TRACK", orgId, [INDEX_EXPIRY_ATTRIBUTE]: expiryOf(row.recordedAt), ...row }); created += 1;
    if (replaced !== undefined && replaced.sk !== newKey.sk) await store.remove(replaced);
    // The task's pointer to its latest answered row (a later merge with no newer answer still finds it).
    await store.setLatest({ ...latestKey(orgId, row.taskId), entityType: "SECOND_REVIEW_TRACK_LAST", orgId, recordedAt: row.recordedAt, ref: { model: row.model, recordedAt: row.recordedAt, taskId: row.taskId, candidateDigest: row.candidateDigest }, [INDEX_EXPIRY_ATTRIBUTE]: expiryOf(row.recordedAt) });
  }
  const moves = [...change.moves];
  if (change.mergedTask !== undefined) {
    const ref = (await store.get(latestKey(orgId, change.mergedTask)))?.ref as Partial<RowRef> | undefined;
    if (typeof ref?.model === "string" && typeof ref.recordedAt === "string" && typeof ref.taskId === "string" && typeof ref.candidateDigest === "string") moves.push({ ref: { model: ref.model, recordedAt: ref.recordedAt, taskId: ref.taskId, candidateDigest: ref.candidateDigest }, to: "wrong" });
  }
  for (const move of moves) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const key = trackRowKey(orgId, move.ref);
      const row = rowOf(await store.get(key));
      if (row === undefined) break;
      const movable = (finding: SecondReviewTrackRow["findings"][number]): boolean => finding.outcome === "open"
        && (move.only === undefined || move.only.has(finding.fp)) && !raisedAgain(finding, move.except)
        // Agreed with only when the new code touched the file the finding cites.
        && (move.to !== "fixed" || (finding.file !== undefined && move.changed?.has(finding.file) === true));
      const findings = row.findings.map((finding) => (movable(finding) ? { ...finding, outcome: move.to } : finding));
      if (findings.every((finding, index) => finding.outcome === row.findings[index]!.outcome)) break;
      if (await store.move(key, findings, row.rev)) { moved += 1; break; }
    }
  }
  return { created, moved };
}

/**
 * The files (paths) the new candidate changed since the earlier one, for a task record, or undefined when that cannot be known. The track record cannot see a candidate's diff by itself (it lives with the task's
 * operations, not on the task record), so whoever wires the indexer supplies this; without it no finding is ever counted as fixed.
 */
export type ChangedFilesPort = (task: Record<string, unknown>, fromCandidateDigest: string, toCandidateDigest: string) => Promise<readonly string[] | undefined>;

/** The stream handler: every task record that changes a second opinion's story. Best effort and bounded; it never fails the batch. */
export async function indexSecondReviewTrack(records: readonly StreamRecord[], store: TrackStore, log: (entry: Record<string, unknown>) => void, fallbackOrg: OrgId, changedFiles?: ChangedFilesPort): Promise<{ created: number; moved: number; failed: number }> {
  const total = { created: 0, moved: 0, failed: 0 };
  for (const entry of records) {
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    try {
      const next = unmarshall(image) as Record<string, unknown>;
      if (next.entityType !== "DEVELOPER_TASK" || next.secondOpinion === undefined) continue;
      const previous = entry.dynamodb?.OldImage === undefined ? undefined : unmarshall(entry.dynamodb.OldImage) as Record<string, unknown>;
      const change = trackChangeOf(previous, next);
      if (change.create === undefined && change.moves.length === 0 && change.mergedTask === undefined) continue;
      // Which files the new code changed, asked only when a finding could be fixed. With no port, or no answer, nothing is counted as fixed.
      const toDigest = opinionOf(next)?.candidateDigest;
      for (const move of change.moves) {
        if (move.to !== "fixed" || changedFiles === undefined || toDigest === undefined) continue;
        try { const files = await changedFiles(next, move.ref.candidateDigest, toDigest); if (files !== undefined) move.changed = new Set(files.map(fileHash)); } catch (error) {
          log({ event: "second_review_track.changed_files_failed", error: error instanceof Error ? error.name : "unknown" });
        }
      }
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

const TRACK_PAGE_SIZE = 500;
/**
 * Every row of one model on a company, optionally for a window of recording times, read by sort key range and paged through to the end (the window, not a page count, bounds the read; rows also expire after
 * `TRACK_RETENTION_DAYS`). A page that cannot be read fails the read, never a partial count.
 */
export async function readTrackRows(table: SettingsTable, orgId: string, model: string, window?: { from: string; to: string }): Promise<SecondReviewTrackRow[]> {
  const prefix = trackPrefix(model);
  // Times start with a digit and the key goes on with `#`, both before `~`: the range holds every row recorded from `from` to `to`, inclusive.
  const low = `${prefix}${window?.from ?? ""}`, high = `${prefix}${window?.to ?? ""}~`;
  const rows: SecondReviewTrackRow[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high", ConsistentRead: true, Limit: TRACK_PAGE_SIZE, ExpressionAttributeValues: { ":pk": orgPk(orgId), ":low": low, ":high": high },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) { const row = rowOf(item); if (row !== undefined && row.model === model) rows.push(row); }
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return rows;
}

/** The settings page shows the last this many days of a model's record (a verdict names its own window instead). */
export const TRACK_RECORD_DAYS = 90;

/** The track record of a model on a company for a window of dates: the one given (a verdict's), else the last `TRACK_RECORD_DAYS` days up to `now`. */
export async function readTrackRecord(table: SettingsTable, orgId: string, model: string, window?: { from: string; to: string }, now: number = Date.now()): Promise<SecondReviewTrackRecord> {
  const range = window ?? { from: new Date(now - TRACK_RECORD_DAYS * 86_400_000).toISOString(), to: new Date(now).toISOString() };
  return summarizeSecondReviewTrack(model, await readTrackRows(table, orgId, model, range), range);
}
