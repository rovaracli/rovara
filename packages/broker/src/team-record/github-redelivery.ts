// SRL-5a: the sweep that asks GitHub to send a failed delete webhook again. GitHub never redelivers on its own, and the webhook answers 503 when the record could not take a delete (a
// comment delete or a repository delete or transfer), so without this the stored copy of deleted GitHub content could stay for good. Design and bound:
// .superpowers/sdd/srl5-github-delete-sweep/design.md.
//
// What it does: through the GitHub App (ports below) it lists the App's recent webhook deliveries, finds the ones that carried a record removal and failed at our side, TRACKS each of them (by guid,
// with the time of its first failure and how often it was asked for) and asks GitHub to send each again until an attempt is answered 2xx or about three days have passed. The webhook's own tap then
// does the delete, with all of its safeguards. What it never does: write or remove a record row, read one, or redeliver anything that is not a removal (a replayed "created" or "edited" of a
// comment deleted since could write the old text again). An error is never a deletion; it is a count and a fixed log line.
//
// Bounded by design: a scan stops at the watermark (less an overlap), at a page limit and at a time budget; what a scan could not reach is kept as a gap and scanned (oldest first) by the next run.
import { isRecordRemovalDelivery } from "./sources/github.js";

export { isRecordRemovalDelivery };

export interface DeliveryEntry {
  /** GitHub's delivery id of THIS attempt (what `/attempts` takes). */
  id: number;
  /** The `X-GitHub-Delivery` guid: shared by a delivery and every redelivery of it. */
  guid: string;
  deliveredAt: string;
  redelivery: boolean;
  event: string;
  action: string | null;
  /** The HTTP status we answered; 0 for a timeout or a refused connection. */
  statusCode: number;
}

export interface DeliveriesPort {
  /** Newest first. `cursor` is opaque (GitHub's `Link` header). Throws when GitHub did not answer a list. `signal` ends the call at the sweep's deadline. */
  list(input: { cursor?: string; perPage: number; signal?: AbortSignal }): Promise<{ entries: DeliveryEntry[]; next?: string }>;
  /** `gone`: GitHub says it no longer has the delivery (404, and nothing else). Throws on anything else that is not an accepted request. */
  redeliver(deliveryId: number, signal?: AbortSignal): Promise<"requested" | "gone">;
}

/** A part of the list a scan did not reach: continue at `cursor`, down to `until` (unset: to the end of what GitHub keeps). `from` is the time of the delivery at the cursor. */
export interface RedeliveryGap { cursor: string; from: string; until?: string }

/** A removal delivery that failed at our side and is not yet seen to succeed. */
export interface TrackedDelivery {
  guid: string;
  /** The newest attempt seen: what `/attempts` is asked about. */
  entryId: number;
  /** When the newest attempt seen was made. */
  lastAt: string;
  /** The oldest failed attempt seen: GitHub forgets the delivery three days after it. */
  firstFailedAt: string;
  /** When we last asked, and how often. */
  askedAt?: string;
  asks: number;
}

export interface RedeliveryState { watermark?: string; gaps: RedeliveryGap[]; tracked: TrackedDelivery[]; /** Opaque; the store's version of what was read (see `save`). */ version?: number }

/** Thrown by `save` when another run saved since this one loaded: this run's state is dropped, never written over the other's. */
export class RedeliveryStateConflict extends Error {
  constructor() { super("the redelivery state changed since it was read"); this.name = "RedeliveryStateConflict"; }
}

export interface RedeliveryStatePort {
  load(): Promise<RedeliveryState | undefined>;
  /** Saves only if the stored state is still the version `previous` (none: still none). Throws `RedeliveryStateConflict` otherwise. */
  save(next: Omit<RedeliveryState, "version">, previous: number | undefined): Promise<void>;
}

export interface RedeliveryDependencies {
  deliveries: DeliveriesPort;
  state: RedeliveryStatePort;
  now?: () => number;
  /** Fixed event names and counts only. */
  log?: (event: string, fields: Record<string, number>) => void;
  maxPages?: number;
  maxRedeliveries?: number;
}

export interface RedeliveryOutcome {
  status: "ok" | "failed";
  listed: number;
  /** Removals GitHub accepted a new attempt for in this run. */
  redelivered: number;
  /** GitHub said it no longer has the delivery (404): done, not counted as redelivered. */
  gone: number;
  failed: number;
  /** Removals left for the next run (the per-run limit). */
  deferred: number;
  /** Removals given up on: three days after their first failure (GitHub has forgotten them), or the most asks. */
  exhausted: number;
  /** Failed removals that could not be tracked (the list is full): the watermark is held so the next run finds them again. */
  untracked: number;
  /** Removals being tracked after this run. */
  tracked: number;
  /** Gaps saved for the next run. */
  gaps: number;
  /** Gaps dropped: GitHub had forgotten them, or more than the limit. */
  droppedGaps: number;
  /** Another run saved first; this run's state was not written. */
  conflict?: true;
}

/** GitHub keeps a delivery for three days. */
export const REDELIVERY_RETENTION_MS = 72 * 3_600_000;
/** A removal whose newest attempt (or last ask) is younger than this is left for the next run, so two runs in a row ask once. */
export const REDELIVERY_MIN_GAP_MS = 30 * 60_000;
/** A scan reaches this far below the watermark, so a delivery listed late is still seen. It MUST NOT be below the minimum gap: an entry skipped for being too young is then always inside the next window. */
export const REDELIVERY_OVERLAP_MS = 30 * 60_000;
export const REDELIVERY_MAX_ASKS = 100;
export const REDELIVERY_MAX_GAPS = 8;
export const REDELIVERY_MAX_TRACKED = 400;
const PAGE_SIZE = 100;
/** About 1,000 to 1,500 deliveries fit the 5 s budget at 300 to 500 ms a page; more than this is carried over as gaps. */
const MAX_PAGES = 25;
const MAX_REDELIVERIES = 50;

const succeeded = (statusCode: number): boolean => statusCode >= 200 && statusCode < 300;

interface Scan { cursor?: string; from?: string; until?: string }
interface Seen { newest: DeliveryEntry; oldestFailedAt: number; delivered: boolean }

export async function runGithubRedelivery(deps: RedeliveryDependencies, options: { budgetMs: number }): Promise<RedeliveryOutcome> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const started = now();
  const deadline = started + options.budgetMs;
  const maxPages = deps.maxPages ?? MAX_PAGES;
  const maxRedeliveries = deps.maxRedeliveries ?? MAX_REDELIVERIES;
  const outcome: RedeliveryOutcome = { status: "ok", listed: 0, redelivered: 0, gone: 0, failed: 0, deferred: 0, exhausted: 0, untracked: 0, tracked: 0, gaps: 0, droppedGaps: 0 };
  const fail = (event: string): RedeliveryOutcome => { log(event, {}); return { ...outcome, status: "failed" }; };
  const remaining = (): AbortSignal => AbortSignal.timeout(Math.max(1, deadline - now()));

  let state: RedeliveryState | undefined;
  try { state = await deps.state.load(); } catch { return fail("record.github_redelivery_state_unreadable"); }
  const watermark = state?.watermark === undefined ? undefined : Date.parse(state.watermark);
  const topUntil = watermark === undefined || !Number.isFinite(watermark) ? undefined : new Date(watermark - REDELIVERY_OVERLAP_MS).toISOString();

  // A gap older than what GitHub keeps cannot be read any more.
  const live: RedeliveryGap[] = [];
  for (const gap of state?.gaps ?? []) {
    if (Date.parse(gap.from) < started - REDELIVERY_RETENTION_MS) outcome.droppedGaps += 1;
    else live.push(gap);
  }
  // The newest part first, then the saved gaps OLDEST first: they are the ones GitHub forgets first.
  live.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  const scans: Scan[] = [{ ...(topUntil === undefined ? {} : { until: topUntil }) }, ...live.map((gap): Scan => ({ cursor: gap.cursor, from: gap.from, ...(gap.until === undefined ? {} : { until: gap.until }) }))];

  const seen = new Map<string, Seen>();
  const gaps: RedeliveryGap[] = [];
  let pages = 0;
  for (const scan of scans) {
    let cursor = scan.cursor;
    let lastAt = scan.from;
    const until = scan.until === undefined ? undefined : Date.parse(scan.until);
    for (;;) {
      if (pages >= maxPages || now() >= deadline) {
        // Out of pages or time: what is left of this scan is kept as it is.
        // The top scan not even started (no time left): nothing was learned, so nothing is changed.
        if (cursor === undefined && lastAt === undefined) return fail("record.github_redelivery_no_budget");
        if (cursor !== undefined && lastAt !== undefined) gaps.push({ cursor, from: lastAt, ...(scan.until === undefined ? {} : { until: scan.until }) });
        break;
      }
      let page: Awaited<ReturnType<DeliveriesPort["list"]>>;
      pages += 1;
      try {
        page = await deps.deliveries.list({ ...(cursor === undefined ? {} : { cursor }), perPage: PAGE_SIZE, signal: remaining() });
      } catch {
        outcome.status = "failed";
        log("record.github_redelivery_list_failed", {});
        // The very first page of the run: nothing was learned, nothing is changed. Otherwise the rest of this scan waits as a gap.
        if (cursor === undefined) return { ...outcome };
        if (lastAt !== undefined) gaps.push({ cursor, from: lastAt, ...(scan.until === undefined ? {} : { until: scan.until }) });
        break;
      }
      let finished = page.next === undefined;
      for (const entry of page.entries) {
        const at = Date.parse(entry.deliveredAt);
        if (!Number.isFinite(at)) continue;
        if (until !== undefined && at < until) { finished = true; break; }
        outcome.listed += 1;
        lastAt = entry.deliveredAt;
        const known = seen.get(entry.guid);
        const failedAt = succeeded(entry.statusCode) ? Number.POSITIVE_INFINITY : at;
        if (known === undefined) seen.set(entry.guid, { newest: entry, oldestFailedAt: failedAt, delivered: succeeded(entry.statusCode) });
        else {
          known.delivered ||= succeeded(entry.statusCode);
          known.oldestFailedAt = Math.min(known.oldestFailedAt, failedAt);
          if (at > Date.parse(known.newest.deliveredAt)) known.newest = entry;
        }
      }
      if (finished || page.entries.length === 0) break;
      cursor = page.next;
    }
  }

  // ---- tracking: what is still to be asked for, with its first failure and its asks, kept across runs
  const tracked = new Map<string, TrackedDelivery>();
  const givenUp = new Set<string>();
  for (const item of state?.tracked ?? []) {
    const view = seen.get(item.guid);
    if (view?.delivered === true) continue; // an attempt got a 2xx: done
    if (started - Date.parse(item.firstFailedAt) >= REDELIVERY_RETENTION_MS || item.asks >= REDELIVERY_MAX_ASKS) {
      outcome.exhausted += 1;
      givenUp.add(item.guid);
      log("record.github_redelivery_exhausted", {});
      continue;
    }
    tracked.set(item.guid, view !== undefined && Date.parse(view.newest.deliveredAt) > Date.parse(item.lastAt) ? { ...item, entryId: view.newest.id, lastAt: view.newest.deliveredAt } : item);
  }
  // A failed removal seen in this run's scans: tracked from its first failure.
  let pinned: number | undefined;
  for (const [guid, view] of seen) {
    const { newest } = view;
    if (view.delivered || tracked.has(guid) || givenUp.has(guid) || !isRecordRemovalDelivery(newest.event, newest.action) || succeeded(newest.statusCode)) continue;
    if (started - view.oldestFailedAt >= REDELIVERY_RETENTION_MS) continue; // GitHub is about to forget it, and it was never tracked: nothing to give up on
    if (tracked.size >= REDELIVERY_MAX_TRACKED) {
      // No room: the watermark is held at it, so the next run finds it again.
      outcome.untracked += 1;
      pinned = pinned === undefined ? Date.parse(newest.deliveredAt) : Math.min(pinned, Date.parse(newest.deliveredAt));
      continue;
    }
    tracked.set(guid, { guid, entryId: newest.id, lastAt: newest.deliveredAt, firstFailedAt: new Date(view.oldestFailedAt).toISOString(), asks: 0 });
  }
  if (outcome.untracked > 0) log("record.github_redelivery_untracked", { count: outcome.untracked });

  // ---- asking: new failures first, then the least asked, then the oldest; one that always fails cannot starve the others
  const due = [...tracked.values()]
    .filter((item) => started - Math.max(Date.parse(item.lastAt), item.askedAt === undefined ? 0 : Date.parse(item.askedAt)) >= REDELIVERY_MIN_GAP_MS)
    .sort((a, b) => a.asks - b.asks || Date.parse(a.firstFailedAt) - Date.parse(b.firstFailedAt));
  for (const [index, item] of due.entries()) {
    if (index >= maxRedeliveries || now() >= deadline) { outcome.deferred += 1; continue; }
    try {
      const answer = await deps.deliveries.redeliver(item.entryId, remaining());
      if (answer === "gone") { outcome.gone += 1; tracked.delete(item.guid); continue; }
      outcome.redelivered += 1;
      tracked.set(item.guid, { ...item, asks: item.asks + 1, askedAt: new Date(now()).toISOString() });
    } catch {
      outcome.failed += 1;
      outcome.status = "failed";
      log("record.github_redelivery_request_failed", {});
    }
  }
  if (outcome.redelivered > 0) log("record.github_redelivery_requested", { count: outcome.redelivered });
  if (outcome.deferred > 0) log("record.github_redelivery_deferred", { count: outcome.deferred });

  // ---- gaps: the oldest are kept (GitHub forgets them first); the newest go when there are too many, and the loss is said with its time range
  gaps.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  if (gaps.length > REDELIVERY_MAX_GAPS) {
    const dropped = gaps.splice(REDELIVERY_MAX_GAPS);
    outcome.droppedGaps += dropped.length;
    outcome.status = "failed";
    log("record.github_redelivery_gaps_dropped", { count: dropped.length, fromEpochSeconds: Math.floor(Date.parse(dropped[dropped.length - 1]!.from) / 1000), toEpochSeconds: Math.floor(Date.parse(dropped[0]!.from) / 1000) });
  }
  outcome.gaps = gaps.length;
  outcome.tracked = tracked.size;
  const mark = pinned === undefined ? started : Math.max(Math.min(started, pinned), started - REDELIVERY_RETENTION_MS);
  try {
    await deps.state.save({ watermark: new Date(mark).toISOString(), gaps, tracked: [...tracked.values()] }, state?.version);
  } catch (error) {
    if (error instanceof RedeliveryStateConflict) { outcome.conflict = true; log("record.github_redelivery_state_conflict", {}); }
    else { outcome.status = "failed"; log("record.github_redelivery_state_unsaved", {}); }
  }
  return outcome;
}
