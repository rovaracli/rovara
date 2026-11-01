// P6: the poller framework, for a code host that cannot reach the broker with webhooks (`events.mode === "poll"`).
//
// An install registers the change requests it follows. A pass reads each one that is due through the host's port (`changeRequestStatus`), compares what it finds with what the last pass saw
// (the target's cursor) and turns every difference into the same neutral events a webhook would have given. Events carry stable ids, so a pass that is repeated, or whose events were
// consumed but whose cursor was not saved, finds the same events again and the intake drops them (`reserveAndConsume`).
//
// Bounds, all tested:
//  - a pass spends at most `maxRequests` reads in all, and one target at most `maxRequestsPerTarget`; reads are counted through the port's own `ReadBudget` (`beforeRequest`), so what a host
//    spends to answer one call is the host's business and is still counted;
//  - targets are polled oldest-due first, so a pass that runs out of allowance starts the next one where it stopped; the targets it did not reach are `delayed`, and when the oldest of them
//    is older than `staleAfterMs` the report says `events_delayed` (the health warning);
//  - a host's rate limit (`HostRateLimitError`) stops the pass for that host until the time it gave, and the next passes do not ask it before then;
//  - one target that fails is retried with a growing, capped delay and never stops the others; one install follows at most `MAX_POLL_TARGETS` change requests.
// What a pass does not do: read comments (that needs the host's feedback read for each target). A review, a check, a push to the change request, and its merge or close are found.
import { createHash } from "node:crypto";
import {
  agentXError, hostRateLimitRetryAt, type ChangeRequestRef, type ChangeRequestState, type ChangeRequestStatus, type CodeHost, type CodeHostEvent, type HostScope, type PluginKind, type ReadBudget,
} from "@agentx/contracts";
import { reserveAndConsume } from "./intake.js";
import type { EventReservations } from "./reservations.js";

/** The most change requests one install follows through the poller. */
export const MAX_POLL_TARGETS = 500;
/** What the cursor remembers of the reviews and checks it has seen (the newest are kept). */
export const MAX_SEEN_FACTS = 400;
export const DEFAULT_POLL_INTERVAL_MS = 90_000;
/** A closed (not merged) change request may be reopened, so it is still looked at, but not as often. */
export const CLOSED_POLL_INTERVAL_MS = 15 * 60_000;
export const POLL_RETRY_MAX_MS = 60 * 60_000;

/** A change request the install follows. `id` names it for the store: the host's kind, its repository and its id. */
export interface PollTarget {
  id: string;
  ref: ChangeRequestRef;
}

/** What the last pass saw of a change request. */
export interface PollCursor {
  state: ChangeRequestState;
  head: string;
  /** Digests of the reviews and checks already reported (a baseline poll reports none). */
  seen: string[];
}

export interface DuePoll {
  target: PollTarget;
  cursor?: PollCursor | undefined;
  dueAt: number;
  /** Consecutive failed passes. */
  attempts: number;
}

export interface PollStore {
  /** Every target of the host, due or not, with its cursor (at most `MAX_POLL_TARGETS`). */
  targets(kind: PluginKind): Promise<DuePoll[]>;
  /** Saves the target's next state: its cursor and when it is next due, or removes it when `next` is "done". */
  save(kind: PluginKind, poll: DuePoll, next: { cursor: PollCursor; dueAt: number; attempts: number } | "done"): Promise<void>;
  /** When the host last told Rovara to slow down, if it is still in the future. */
  blockedUntil(kind: PluginKind): Promise<number | undefined>;
  block(kind: PluginKind, until: number): Promise<void>;
}

/** Thrown from the read allowance when a pass has used it up. */
export class PollBudgetSpent extends Error {
  constructor(readonly scope: "pass" | "target") {
    super(scope === "pass" ? "the poll pass used its read allowance" : "a change request used its read allowance");
    this.name = "PollBudgetSpent";
  }
}

const digest = (...parts: string[]): string => createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");

/** A read allowance that counts every request and stops at `cap`; it also stops with `signal`. */
export function countedBudget(cap: number, scope: "pass" | "target", signal: AbortSignal, parent?: ReadBudget): ReadBudget & { used(): number } {
  let used = 0;
  return {
    signal,
    beforeRequest: () => {
      // A stopped caller ends the whole pass, whichever allowance asked.
      if (signal.aborted) throw new PollBudgetSpent("pass");
      if (used >= cap) throw new PollBudgetSpent(scope);
      parent?.beforeRequest();
      used += 1;
    },
    used: () => used,
  };
}

const rememberFacts = (seen: readonly string[], fresh: readonly string[]): string[] => [...seen, ...fresh.filter((fact) => !seen.includes(fact))].slice(-MAX_SEEN_FACTS);

/**
 * What changed in a change request since the cursor, as neutral events, and the cursor to keep. Pure.
 *  - No cursor: this is the first look. Nothing is reported as new, except that a change request already merged or closed is reported as that.
 *  - open -> merged / closed: that event (a merged one ends the target). closed -> open: `updated`. A new head while open: `updated`.
 *  - a review not seen before: `review.submitted`; a finished check not seen before: `check.completed`.
 */
export function pollChanges(kind: PluginKind, target: PollTarget, cursor: PollCursor | undefined, status: ChangeRequestStatus): { events: CodeHostEvent[]; cursor: PollCursor; ended: boolean } {
  const base = { host: kind } as const;
  const id = (type: string, ...facts: string[]) => `poll-${digest(kind, target.id, type, ...facts).slice(0, 40)}`;
  const events: CodeHostEvent[] = [];
  const facts: string[] = [];
  const reviewFact = (review: ChangeRequestStatus["reviews"][number]) => digest("review", review.reviewer.login, review.state, review.revision, review.submittedAt);
  const checkFact = (check: ChangeRequestStatus["checks"][number]) => digest("check", check.name, status.headRevision, check.conclusion ?? "");
  const seenNow = [...status.reviews.map(reviewFact), ...status.checks.filter((check) => check.state === "completed" && check.conclusion !== undefined).map(checkFact)];
  if (cursor === undefined) {
    if (status.state === "merged") events.push({ ...base, eventId: id("merged", status.headRevision), type: "change_request.merged", ref: target.ref });
    else if (status.state === "closed") events.push({ ...base, eventId: id("closed", status.headRevision), type: "change_request.closed", ref: target.ref });
    return { events, cursor: { state: status.state, head: status.headRevision, seen: rememberFacts([], seenNow) }, ended: status.state === "merged" };
  }
  if (cursor.state === "merged") return { events, cursor, ended: true };
  if (status.state === "merged") events.push({ ...base, eventId: id("merged", status.headRevision), type: "change_request.merged", ref: target.ref });
  else if (status.state === "closed" && cursor.state === "open") events.push({ ...base, eventId: id("closed", status.headRevision), type: "change_request.closed", ref: target.ref });
  else if (status.state === "open" && cursor.state === "closed") events.push({ ...base, eventId: id("reopened", status.headRevision), type: "change_request.updated", ref: target.ref });
  else if (status.state === "open" && status.headRevision !== cursor.head) events.push({ ...base, eventId: id("updated", cursor.head, status.headRevision), type: "change_request.updated", ref: target.ref });
  for (const review of status.reviews) {
    const fact = reviewFact(review);
    if (cursor.seen.includes(fact)) continue;
    facts.push(fact);
    events.push({ ...base, eventId: id("review", fact), type: "review.submitted", ref: target.ref, state: review.state, actor: review.reviewer.login.slice(0, 200) });
  }
  for (const check of status.checks) {
    if (check.state !== "completed" || check.conclusion === undefined) continue;
    const fact = checkFact(check);
    if (cursor.seen.includes(fact)) continue;
    facts.push(fact);
    events.push({ ...base, eventId: id("check", fact), type: "check.completed", repository: target.ref.repository, revision: status.headRevision, name: check.name, conclusion: check.conclusion });
  }
  return { events, cursor: { state: status.state, head: status.headRevision, seen: rememberFacts(cursor.seen, facts) }, ended: status.state === "merged" };
}

export interface PollPassInput {
  host: CodeHost;
  scope: HostScope;
  store: PollStore;
  reservations: EventReservations;
  /** Consumes one new event (the same consumer a webhook's events go to). Throws to leave the target's cursor where it was, so the pass finds the event again. */
  consume(event: CodeHostEvent): Promise<void>;
  now(): number;
  /** The most reads this pass may spend in all. */
  maxRequests: number;
  /** The most reads one change request may spend. */
  maxRequestsPerTarget: number;
  signal?: AbortSignal;
  /** Time between looks at an open change request. Default `DEFAULT_POLL_INTERVAL_MS`. */
  intervalMs?: number;
  /** A target due for longer than this and not reached makes the report `events_delayed`. Default four intervals. */
  staleAfterMs?: number;
}

export interface PollPassReport {
  host: PluginKind;
  polled: number;
  /** Targets that were due and were not reached (the allowance, the rate limit, or the signal stopped the pass first). */
  delayed: number;
  failed: number;
  events: number;
  duplicates: number;
  requests: number;
  stoppedBy?: "allowance" | "rate_limit" | "signal" | "blocked";
  rateLimitedUntil?: number;
  /** `events_delayed` when the oldest target not reached has been due longer than `staleAfterMs`. */
  health: "ok" | "events_delayed";
  oldestDelayedMs?: number;
}

export async function runPollPass(input: PollPassInput): Promise<PollPassReport> {
  const kind = input.host.kind;
  const interval = input.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleAfter = input.staleAfterMs ?? interval * 4;
  const now = input.now();
  const report: PollPassReport = { host: kind, polled: 0, delayed: 0, failed: 0, events: 0, duplicates: 0, requests: 0, health: "ok" };
  if (input.host.events.mode !== "poll") throw agentXError("CONFIG_INVALID", "This code host is not polled.");
  const blocked = await input.store.blockedUntil(kind);
  const due = (await input.store.targets(kind)).filter((poll) => poll.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt || (a.target.id < b.target.id ? -1 : 1));
  const delay = (from: number): void => {
    report.delayed = due.length - from;
    const waiting = due[from];
    if (waiting !== undefined) {
      report.oldestDelayedMs = now - waiting.dueAt;
      if (report.oldestDelayedMs > staleAfter) report.health = "events_delayed";
    }
  };
  if (blocked !== undefined && blocked > now) {
    report.stoppedBy = "blocked";
    report.rateLimitedUntil = blocked;
    delay(0);
    return report;
  }
  const signal = input.signal ?? new AbortController().signal;
  const pass = countedBudget(input.maxRequests, "pass", signal);
  for (const [position, poll] of due.entries()) {
    const own = countedBudget(input.maxRequestsPerTarget, "target", signal, pass);
    let status: ChangeRequestStatus;
    try {
      status = await input.host.changeRequestStatus(poll.target.ref, input.scope, own);
    } catch (error) {
      const limitedUntil = hostRateLimitRetryAt(error);
      if (limitedUntil !== undefined) {
        await input.store.block(kind, limitedUntil);
        report.stoppedBy = "rate_limit";
        report.rateLimitedUntil = limitedUntil;
        delay(position);
        break;
      }
      if (error instanceof PollBudgetSpent && error.scope === "pass") {
        report.stoppedBy = signal.aborted ? "signal" : "allowance";
        delay(position);
        break;
      }
      // One change request that cannot be read (its own allowance spent, the host refusing it) waits longer each time and never stops the others.
      report.failed += 1;
      const attempts = poll.attempts + 1;
      await input.store.save(kind, poll, { cursor: poll.cursor ?? { state: "open", head: "", seen: [] }, dueAt: now + Math.min(interval * 2 ** attempts, POLL_RETRY_MAX_MS), attempts });
      continue;
    }
    report.polled += 1;
    const changes = pollChanges(kind, poll.target, poll.cursor, status);
    try {
      const delivered = await reserveAndConsume(changes.events, input.reservations, (event) => input.consume(event));
      report.events += delivered.consumed.length;
      report.duplicates += delivered.duplicates;
    } catch {
      // The cursor stays where it was: the next pass finds the same events (same ids) and the ones already consumed are dropped.
      report.failed += 1;
      await input.store.save(kind, poll, { cursor: poll.cursor ?? changes.cursor, dueAt: now + Math.min(interval * 2 ** (poll.attempts + 1), POLL_RETRY_MAX_MS), attempts: poll.attempts + 1 });
      continue;
    }
    await input.store.save(kind, poll, changes.ended ? "done" : { cursor: changes.cursor, dueAt: now + (changes.cursor.state === "closed" ? CLOSED_POLL_INTERVAL_MS : interval), attempts: 0 });
    if (signal.aborted) {
      report.stoppedBy = "signal";
      delay(position + 1);
      break;
    }
  }
  report.requests = pass.used();
  return report;
}
