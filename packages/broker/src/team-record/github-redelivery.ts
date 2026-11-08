// SRL-5a: the sweep that asks GitHub to send a failed delete webhook again. GitHub never redelivers on its own, and the webhook answers 503 when the record could not take a delete (a
// comment delete or a repository delete or transfer), so without this the stored copy of deleted GitHub content could stay for good. Design and bound:
// .superpowers/sdd/srl5-github-delete-sweep/design.md.
//
// What it does: through the GitHub App (ports below) it lists the App's recent webhook deliveries, finds the ones that carried a record removal and failed at our side, and asks GitHub to send
// each again. The webhook's own tap then does the delete, with all of its safeguards. What it never does: write or remove a record row, read one, or redeliver anything that is not a
// removal (a replayed "created" or "edited" of a comment deleted since could write the old text again). An error is never a deletion; it is a count and a fixed log line.
//
// Bounded by design: a scan stops at the watermark (less an overlap), at a page limit and at a time budget; what a scan could not reach is kept as a gap and scanned first by the next run.

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
  /** Newest first. `cursor` is opaque (GitHub's `Link` header). Throws when GitHub did not answer a list. */
  list(input: { cursor?: string; perPage: number }): Promise<{ entries: DeliveryEntry[]; next?: string }>;
  /** `gone`: GitHub no longer has the delivery. Throws on anything else that is not an accepted request. */
  redeliver(deliveryId: number): Promise<"requested" | "gone">;
}

/** A part of the list a scan did not reach: continue at `cursor`, down to `until` (unset: to the end of what GitHub keeps). `from` is the time of the delivery at the cursor. */
export interface RedeliveryGap { cursor: string; from: string; until?: string }
export interface RedeliveryState { watermark?: string; gaps: RedeliveryGap[] }
export interface RedeliveryStatePort {
  load(): Promise<RedeliveryState | undefined>;
  save(state: RedeliveryState): Promise<void>;
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
  redelivered: number;
  failed: number;
  /** Removals left for the next run (the per-run limit). */
  deferred: number;
  /** Removals that already had the most attempts a guid may have. */
  exhausted: number;
  /** Gaps saved for the next run. */
  gaps: number;
  /** Gaps dropped: GitHub had forgotten them, or more than the limit. */
  droppedGaps: number;
}

/** GitHub keeps a delivery for three days. */
export const REDELIVERY_RETENTION_MS = 72 * 3_600_000;
/** A newest attempt younger than this is left for the next run, so two runs in a row ask once. */
export const REDELIVERY_MIN_GAP_MS = 30 * 60_000;
/** A scan reaches this far below the watermark, so a delivery listed late is still seen. */
export const REDELIVERY_OVERLAP_MS = 30 * 60_000;
export const REDELIVERY_MAX_ATTEMPTS = 100;
export const REDELIVERY_MAX_GAPS = 8;
const PAGE_SIZE = 100;
const MAX_PAGES = 25;
const MAX_REDELIVERIES = 50;

/** The deliveries whose failure can leave deleted content in the record: exactly what the tap removes on (`sources/codehost.ts`: a deleted comment, a deleted or transferred repository). */
export function isRecordRemovalDelivery(event: string, action: string | null): boolean {
  if (event === "issue_comment" || event === "pull_request_review_comment") return action === "deleted";
  if (event === "repository") return action === "deleted" || action === "transferred";
  return false;
}

/** A failure worth asking again for: a timeout or refused connection (0), "too early" or "too many" (408, 429) and a server error. Any other 4xx is our own refusal and would only be refused again. */
const retryable = (statusCode: number): boolean => statusCode === 0 || statusCode === 408 || statusCode === 429 || statusCode >= 500;
const succeeded = (statusCode: number): boolean => statusCode >= 200 && statusCode < 300;

interface Scan { cursor?: string; from?: string; until?: string }
interface Guid { newest: DeliveryEntry; attempts: number; delivered: boolean }

export async function runGithubRedelivery(deps: RedeliveryDependencies, options: { budgetMs: number }): Promise<RedeliveryOutcome> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const started = now();
  const deadline = started + options.budgetMs;
  const maxPages = deps.maxPages ?? MAX_PAGES;
  const maxRedeliveries = deps.maxRedeliveries ?? MAX_REDELIVERIES;
  const outcome: RedeliveryOutcome = { status: "ok", listed: 0, redelivered: 0, failed: 0, deferred: 0, exhausted: 0, gaps: 0, droppedGaps: 0 };
  const fail = (event: string): RedeliveryOutcome => { log(event, {}); return { ...outcome, status: "failed" }; };

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
  const scans: Scan[] = [{ ...(topUntil === undefined ? {} : { until: topUntil }) }, ...live.map((gap): Scan => ({ cursor: gap.cursor, from: gap.from, ...(gap.until === undefined ? {} : { until: gap.until }) }))];

  const byGuid = new Map<string, Guid>();
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
        page = await deps.deliveries.list({ ...(cursor === undefined ? {} : { cursor }), perPage: PAGE_SIZE });
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
        const known = byGuid.get(entry.guid);
        if (known === undefined) byGuid.set(entry.guid, { newest: entry, attempts: 1, delivered: succeeded(entry.statusCode) });
        else {
          known.attempts += 1;
          known.delivered ||= succeeded(entry.statusCode);
          if (at > Date.parse(known.newest.deliveredAt)) known.newest = entry;
        }
      }
      if (finished || page.entries.length === 0) break;
      cursor = page.next;
    }
  }

  // The removals still to ask for, oldest first.
  const wanted: DeliveryEntry[] = [];
  for (const guid of byGuid.values()) {
    const { newest } = guid;
    if (guid.delivered || !isRecordRemovalDelivery(newest.event, newest.action) || !retryable(newest.statusCode)) continue;
    if (guid.attempts >= REDELIVERY_MAX_ATTEMPTS) { outcome.exhausted += 1; log("record.github_redelivery_exhausted", {}); continue; }
    if (started - Date.parse(newest.deliveredAt) < REDELIVERY_MIN_GAP_MS) continue;
    wanted.push(newest);
  }
  wanted.sort((a, b) => Date.parse(a.deliveredAt) - Date.parse(b.deliveredAt));

  // The watermark may not pass a removal that was not asked for (failed, or over the limit).
  let pinned: number | undefined;
  const hold = (entry: DeliveryEntry): void => { const at = Date.parse(entry.deliveredAt); pinned = pinned === undefined ? at : Math.min(pinned, at); };
  for (const [index, entry] of wanted.entries()) {
    if (index >= maxRedeliveries || now() >= deadline) { outcome.deferred += 1; hold(entry); continue; }
    try {
      await deps.deliveries.redeliver(entry.id);
      outcome.redelivered += 1;
    } catch {
      outcome.failed += 1;
      outcome.status = "failed";
      hold(entry);
      log("record.github_redelivery_request_failed", {});
    }
  }
  if (outcome.redelivered > 0) log("record.github_redelivery_requested", { count: outcome.redelivered });
  if (outcome.deferred > 0) log("record.github_redelivery_deferred", { count: outcome.deferred });

  gaps.sort((a, b) => Date.parse(b.from) - Date.parse(a.from));
  if (gaps.length > REDELIVERY_MAX_GAPS) {
    outcome.droppedGaps += gaps.length - REDELIVERY_MAX_GAPS;
    gaps.length = REDELIVERY_MAX_GAPS;
    log("record.github_redelivery_gaps_dropped", {});
  }
  outcome.gaps = gaps.length;
  const mark = pinned === undefined ? started : Math.max(Math.min(started, pinned), started - REDELIVERY_RETENTION_MS);
  try {
    await deps.state.save({ watermark: new Date(mark).toISOString(), gaps });
  } catch {
    outcome.status = "failed";
    log("record.github_redelivery_state_unsaved", {});
  }
  return outcome;
}
