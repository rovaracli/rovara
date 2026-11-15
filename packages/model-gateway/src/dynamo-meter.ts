import { randomUUID } from "node:crypto";
import { AwsNotSentError } from "./aws.js";
import { validCaps, type Caps } from "./caps.js";
import { GATEWAY_COMPANY_KEY_PREFIX, GATEWAY_LEDGER_INDEXES, GATEWAY_METER_INDEXES, GATEWAY_OPEN_PARTITION, GATEWAY_PENDING_PARTITION } from "./deploy.js";
import { CALL_HARD_CEILING_MS } from "./provider.js";
import { TransactionRefused, type Dynamo, type Expr, type Item, type Plain, type TransactAction } from "./dynamo.js";
import type { EndedTasks } from "./ended.js";
import { SWEEP_AFTER_MAX_MS } from "./meter.js";
import type { CorrectionInput, CorrectionResult, EstimatedCall, EstimatedSettlement, ExpiryInput, Meter, MeterItem, MeterRow, MeterScope, Reservation, ReserveInput, ReserveResult } from "./meter.js";
import { COMPANY, PERSON, PROJECT, TASK, TASK_TOKEN_SECONDS, record, whole } from "./model-gateway-token.js";
import type { PendingPage } from "./pending-page.js";
import { CORRECTION_RUN_MAX, CORRECTION_RUN_MS, DAY_MS, PENDING_RETENTION_DAYS } from "./price-constants.js";
import { priceKey, validEntry, type PriceKey } from "./price-snapshot.js";
import { hasUsage, validUsage } from "./reported-cost.js";
import { MEDIA_USAGE_KEYS, type TokenUsage } from "./usage.js";

/**
 * The DynamoDB Meter (meter.ts's contract; runMeterConformance and runMeterDeadlineConformance hold it to InMemoryMeter).
 *
 *   meter table   CO#[iss,cid] / ROW#[item...]   spend rows (task; person, project, company per month)
 *                 CO#[iss,cid] / HOLD#<id>       one per reservation: open, then settled (kept, never deleted)
 *   ledger table  CO#[iss,cid] / CALL#<id>       one per settled call; an estimated call is "pending" (in both pending
 *                                                indexes) until corrected or expired
 *   markers table CO#[iss,cid] / INFLIGHT        the company's one estimated-price call in flight (expires)
 *                 CO#[iss,cid] / ENDED#<task>    an ended task (written by the task-ended notice, a later lane)
 *
 * Every write that moves money is one conditional transaction, so two servers never lose or double an update: a reservation
 * adds to each row only while the row is still under its cap; a settle moves a hold to spend only while the hold is open; a
 * correction applies only while the ledger row is still pending at the version it read. Nothing here deletes a meter or
 * ledger row (the serving role has no DeleteItem there); only the in-flight marker is deleted.
 */
export interface DynamoMeterTables { meter: string; ledger: string; markers: string }
export interface DynamoMeterOptions {
  db: Dynamo; tables: DynamoMeterTables; now?: () => number;
  /**
   * DEC 228c, the product meter only: the AGENT meter's meter and markers tables. Every hold of this meter also takes the agent
   * meter's company row (`Caps.combinedCompanyMonth`, one combined company monthly cap) in the same conditional transaction, and
   * the company's one overrun-capable call in flight is the agent markers table's INFLIGHT item, shared by both routes.
   */
  combinedCompany?: { meter: string; markers: string };
  /** Test seam (the conformance's pause before commit). */
  beforeWrite?: (operation: "settle" | "correct" | "expire", rows?: MeterRow[]) => void | Promise<void>;
}

export const companyPartition = (iss: string, cid: string): string => `${GATEWAY_COMPANY_KEY_PREFIX}${JSON.stringify([iss, cid])}`;
const INFLIGHT = "INFLIGHT";
const MAX = Number.MAX_SAFE_INTEGER;
const SETTLE_ATTEMPTS = 6;
const CORRECT_ATTEMPTS = 3;
/** Jittered exponential pause between conditional retries (contention on one company's rows), at most ~0.8 s. */
const backoff = (attempt: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, Math.floor(Math.random() * 25 * 2 ** Math.min(attempt, 5))); });
const pad = (n: number): string => String(n).padStart(16, "0");
const pendingKeyAt = (key: string, settledAt: number, callKey: string): string => `${key}|${pad(settledAt)}|${callKey}`;
const pendingAt = (settledAt: number, callKey: string): string => `${pad(settledAt)}|${callKey}`;
const openAt = (createdAt: number, pk: string, id: string): string => `${pad(createdAt)}|${pk}|${id}`;
/** A hold is swept only well after its call must have ended: the one-hour call ceiling plus fifteen minutes. */
export const HOLD_SWEEP_AGE_MS = CALL_HARD_CEILING_MS + 15 * 60_000;
export const HOLD_SWEEP_MAX = 100;

/** `combined`: the agent meter's company row (DynamoMeterOptions.combinedCompany), in the agent meter table. */
interface Target { sk: string; item: MeterItem; cap?: number; combined?: true }
interface Hold { scope: MeterScope; month: string; estimate: number; targets: Target[]; status: string }

function validScope(value: unknown): value is MeterScope {
  const s = record(value);
  return s !== undefined && typeof s.iss === "string" && s.iss.length > 0 && s.iss.length <= 2048 && typeof s.cid === "string" && COMPANY.test(s.cid) && typeof s.pid === "string" && PROJECT.test(s.pid) && typeof s.tid === "string" && TASK.test(s.tid) && (s.per === undefined || (typeof s.per === "string" && PERSON.test(s.per)));
}
function targetsFor(scope: MeterScope, caps: Caps, month: string, combined = false): Target[] {
  const sk = (...parts: string[]) => `ROW#${JSON.stringify(parts)}`;
  const withCap = (target: Target, cap: number | undefined): Target => cap === undefined ? target : { ...target, cap };
  return [
    withCap({ sk: sk("task", scope.tid), item: "task" }, caps.task),
    ...(scope.per === undefined ? [] : [withCap({ sk: sk("person", scope.per, month), item: "person" }, caps.personMonth)]),
    withCap({ sk: sk("project", scope.pid, month), item: "project" }, caps.projectMonth),
    withCap({ sk: sk("company", month), item: "company" }, caps.companyMonth),
    // The agent meter's own company row key, in the agent meter table.
    ...(combined ? [withCap({ sk: sk("company", month), item: "company", combined: true }, caps.combinedCompanyMonth)] : []),
  ];
}
const scopeFields = (scope: MeterScope): Item => ({ iss: scope.iss, cid: scope.cid, pid: scope.pid, tid: scope.tid, ...(scope.per === undefined ? {} : { per: scope.per }) });
const targetsPlain = (targets: readonly Target[]): Plain => targets.map((t) => ({ sk: t.sk, item: t.item, ...(t.cap === undefined ? {} : { cap: t.cap }), ...(t.combined === true ? { combined: true } : {}) }));
/** `combined`: whether this meter combines; a stored combined target on a meter that does not is unreadable (fail closed). */
function readTargets(value: unknown, combined = false): Target[] | undefined {
  if (!Array.isArray(value) || value.length < 3 || value.length > (combined ? 5 : 4)) return undefined;
  const targets: Target[] = [];
  for (const entry of value) {
    const t = record(entry);
    if (t === undefined || typeof t.sk !== "string" || !t.sk.startsWith("ROW#") || !["task", "person", "project", "company"].includes(t.item as string) || (t.cap !== undefined && !whole(t.cap))) return undefined;
    if (t.combined !== undefined && (t.combined !== true || !combined || t.item !== "company")) return undefined;
    targets.push({ sk: t.sk, item: t.item as MeterItem, ...(t.cap === undefined ? {} : { cap: t.cap }), ...(t.combined === true ? { combined: true as const } : {}) });
  }
  return targets;
}
function readHold(item: Item | undefined, combined: boolean): Hold | undefined {
  if (item === undefined) return undefined;
  const scope = { iss: item.iss, cid: item.cid, pid: item.pid, tid: item.tid, ...(item.per === undefined ? {} : { per: item.per }) };
  const targets = readTargets(item.targets, combined);
  if (!validScope(scope) || targets === undefined || typeof item.month !== "string" || !whole(item.estimateMicros) || typeof item.status !== "string") throw new Error("settlement unavailable");
  return { scope, month: item.month, estimate: item.estimateMicros, targets, status: item.status };
}
function rowOf(item: Item | undefined, target: Target, company: string): MeterRow {
  if (item === undefined) return { item: target.item, company, spentMicros: 0, estimatedMicros: 0, reservedMicros: 0, committed: 0, overrun: false };
  const row = { item: item.item, company: item.company, spentMicros: item.spentMicros, estimatedMicros: item.estimatedMicros, reservedMicros: item.reservedMicros, committed: item.committed, overrun: item.overrun };
  if (row.item !== target.item || typeof row.company !== "string" || ![row.spentMicros, row.estimatedMicros, row.reservedMicros, row.committed].every(whole) || typeof row.overrun !== "boolean") throw new Error("meter unavailable");
  return row as MeterRow;
}
function usagePlain(usage: EstimatedSettlement["usage"] & object): Item {
  return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, ...(usage.cacheWrite5m === undefined ? {} : { cacheWrite5m: usage.cacheWrite5m }), ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
    // Audio and video parts (DEC 228e): a correction re-prices them at their own rates, so they are kept.
    ...Object.fromEntries(MEDIA_USAGE_KEYS.filter((k) => usage[k] !== undefined).map((k) => [k, usage[k]!])) };
}
/** A pending ledger row back to the EstimatedCall shape (the meter's fields only; keys, targets and index attributes dropped). */
function toCall(item: Item): EstimatedCall {
  const scope = { iss: item.iss, cid: item.cid, pid: item.pid, tid: item.tid, ...(item.per === undefined ? {} : { per: item.per }) };
  if (!validScope(scope) || typeof item.callKey !== "string" || typeof item.month !== "string" || typeof item.provider !== "string" || typeof item.model !== "string" || (item.kind !== "chat" && item.kind !== "embedding") || !validUsage(item.usage) || !whole(item.settledMicros) || !whole(item.settledAt) || !["pending", "corrected", "expired"].includes(item.status as string)) throw new Error("pending unavailable");
  const optional = ["priceVersion", "correctedFrom", "correctedTo", "correctedAt", "expiredAt"] as const;
  const call: EstimatedCall = { ...scope, callKey: item.callKey, month: item.month, provider: item.provider, model: item.model, kind: item.kind, usage: { ...(item.usage as unknown as TokenUsage) }, settledMicros: item.settledMicros, status: item.status as EstimatedCall["status"], settledAt: item.settledAt };
  for (const name of optional) { const v = item[name]; if (v !== undefined) { if (!whole(v)) throw new Error("pending unavailable"); call[name] = v; } }
  if (typeof item.deltaMicros === "number" && Number.isSafeInteger(item.deltaMicros)) call.deltaMicros = item.deltaMicros;
  if (item.capExceeded === true) call.capExceeded = true;
  if (typeof item.runId === "string") call.runId = item.runId;
  const origin = record(item.priceSource);
  if (origin !== undefined && typeof origin.source === "string" && ["litellm", "aws", "override"].includes(origin.source) && whole(origin.fetchedAt)) call.priceSource = { source: origin.source as "litellm" | "aws" | "override", fetchedAt: origin.fetchedAt };
  return call;
}
function parseCallKey(callKey: string): { pk: string; sk: string; iss: string; cid: string } | undefined {
  let parsed: unknown; try { parsed = JSON.parse(callKey); } catch { return undefined; }
  if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((part) => typeof part === "string") || JSON.stringify(parsed) !== callKey) return undefined;
  const [iss, cid, id] = parsed as [string, string, string];
  if (iss.length === 0 || iss.length > 2048 || !COMPANY.test(cid) || !/^[0-9a-f-]{36}$/u.test(id)) return undefined;
  return { pk: companyPartition(iss, cid), sk: `CALL#${id}`, iss, cid };
}

export class DynamoMeter implements Meter {
  readonly #db: Dynamo;
  readonly #t: DynamoMeterTables;
  readonly #now: () => number;
  readonly #beforeWrite: NonNullable<DynamoMeterOptions["beforeWrite"]>;
  /** Where each reservation this process made lives. A reservation is settled by the process that made it (server.ts's finally). */
  readonly #holds = new WeakMap<object, { pk: string; id: string }>();
  /** Where the next hold sweep resumes (an open-holds index position); undefined: from the oldest. */
  #sweepAfter: string | undefined;
  readonly #combined: { meter: string; markers: string } | undefined;
  constructor(options: DynamoMeterOptions) {
    this.#db = options.db; this.#t = options.tables; this.#now = options.now ?? Date.now; this.#beforeWrite = options.beforeWrite ?? (() => undefined);
    const combined = options.combinedCompany;
    if (combined !== undefined && (typeof combined.meter !== "string" || typeof combined.markers !== "string" || combined.meter.length === 0 || combined.markers.length === 0 || combined.meter === options.tables.meter)) throw new Error("meter unavailable");
    this.#combined = combined === undefined ? undefined : { meter: combined.meter, markers: combined.markers };
  }
  get combinedCompany(): boolean { return this.#combined !== undefined; }
  /** The agent meter tables this meter combines with (startServe checks them against its own). */
  combinedTables(): { meter: string; markers: string } | undefined { return this.#combined === undefined ? undefined : { ...this.#combined }; }
  /** The overrun-in-flight marker's table: the agent markers table when combined (one per company across both routes). */
  get #markers(): string { return this.#combined?.markers ?? this.#t.markers; }
  #table(target: Target): string {
    if (target.combined !== true) return this.#t.meter;
    if (this.#combined === undefined) throw new Error("meter unavailable");
    return this.#combined.meter;
  }
  #month(): string { return new Date(this.#now()).toISOString().slice(0, 7); }
  async #rows(pk: string, targets: readonly Target[]): Promise<Array<Item | undefined>> {
    return Promise.all(targets.map((target) => this.#db.get(this.#table(target), { pk, sk: target.sk })));
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    if (record(input) === undefined || !validScope(input.scope) || !validCaps(input.caps) || !whole(input.estimateMicros)) return { ok: false, reason: "busy" };
    const { scope, caps, estimateMicros } = input;
    if (input.appliedMaxOutputTokens !== undefined && (!whole(input.appliedMaxOutputTokens) || input.appliedMaxOutputTokens < 1)) return { ok: false, reason: "busy" };
    // Fail closed: a combined meter without the combined company cap holds nothing.
    if (this.#combined !== undefined && caps.combinedCompanyMonth === undefined) return { ok: false, reason: "busy" };
    const now = this.#now();
    if (input.sweepAfter !== undefined && (!whole(input.sweepAfter) || input.sweepAfter > now + SWEEP_AFTER_MAX_MS)) return { ok: false, reason: "busy" };
    // The sweep reads a hold's age from openFrom: a long hold (an eval stage) is not swept before its own end.
    const openFrom = Math.max(now, input.sweepAfter ?? now); const clock = Math.floor(now / 1000);
    let expiresSeconds: number | undefined;
    if (input.overrun !== undefined) {
      const marker = record(input.overrun);
      if (marker === undefined || !whole(marker.deadlineSeconds) || !whole(marker.tokenExpiresSeconds)) return { ok: false, reason: "busy" };
      expiresSeconds = Math.min(marker.deadlineSeconds, marker.tokenExpiresSeconds, clock + TASK_TOKEN_SECONDS);
      if (expiresSeconds <= clock) return { ok: false, reason: "busy" };
    }
    const pk = companyPartition(scope.iss, scope.cid);
    const month = this.#month();
    const items = targetsFor(scope, caps, month, this.#combined !== undefined);
    const id = randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) {
      let stored: Array<Item | undefined>;
      try { stored = await this.#rows(pk, items); } catch { return { ok: false, reason: "busy" }; }
      let blocked: Extract<ReserveResult, { reason: "cap" | "overrun" }> | undefined;
      for (const [i, target] of items.entries()) {
        let row: MeterRow;
        try { row = rowOf(stored[i], target, scope.cid); } catch { return { ok: false, reason: "busy" }; }
        if (row.company !== scope.cid) return { ok: false, reason: "busy" };
        if (row.overrun) return { ok: false, reason: "overrun", item: target.item, held: false };
        if (!Number.isSafeInteger(row.committed + estimateMicros)) return { ok: false, reason: "busy" };
        if (target.cap !== undefined && (target.cap - estimateMicros < 0 || row.committed > target.cap - estimateMicros)) {
          const held = row.spentMicros <= target.cap - estimateMicros;
          if (blocked === undefined || !held) blocked = { ok: false, reason: "cap", item: target.item, held };
        }
      }
      if (blocked !== undefined) return blocked;
      if (expiresSeconds !== undefined) {
        let marker: Item | undefined;
        try { marker = await this.#db.get(this.#markers, { pk, sk: INFLIGHT }); } catch { return { ok: false, reason: "busy" }; }
        // Expiry frees only the marker; an unreadable marker counts as live.
        if (marker !== undefined && !(whole(marker.expiresSeconds) && marker.expiresSeconds <= clock)) return { ok: false, reason: "busy", overrunInFlight: true };
      }
      const actions: TransactAction[] = items.map((target, i): TransactAction => {
        const limit = Math.min(target.cap === undefined ? MAX : target.cap - estimateMicros, MAX - estimateMicros);
        if (stored[i] === undefined) {
          return { kind: "Update", table: this.#table(target), key: { pk, sk: target.sk },
            update: (e) => `SET ${e.name("item")} = ${e.value(target.item)}, ${e.name("company")} = ${e.value(scope.cid)}, ${e.name("spentMicros")} = ${e.value(0)}, ${e.name("estimatedMicros")} = ${e.value(0)}, ${e.name("reservedMicros")} = ${e.value(estimateMicros)}, ${e.name("committed")} = ${e.value(estimateMicros)}, ${e.name("overrun")} = ${e.value(false)}`,
            condition: (e) => `attribute_not_exists(${e.name("pk")})` };
        }
        return { kind: "Update", table: this.#table(target), key: { pk, sk: target.sk },
          update: (e) => `SET ${e.name("reservedMicros")} = ${e.name("reservedMicros")} + ${e.value(estimateMicros)}, ${e.name("committed")} = ${e.name("committed")} + ${e.value(estimateMicros)}`,
          condition: (e) => `${e.name("company")} = ${e.value(scope.cid)} AND ${e.name("overrun")} = ${e.value(false)} AND ${e.name("committed")} <= ${e.value(limit)}` };
      });
      actions.push({ kind: "Put", table: this.#t.meter, condition: (e) => `attribute_not_exists(${e.name("pk")})`, item: {
        pk, sk: `HOLD#${id}`, status: "open", ...scopeFields(scope), month, estimateMicros, targets: targetsPlain(items), createdAt: now,
        // In the open-holds index until settled, so the sweep can close a hold whose settle failed.
        openAll: GATEWAY_OPEN_PARTITION, openAt: openAt(openFrom, pk, id), ...(openFrom === now ? {} : { openFrom }),
        ...(input.appliedMaxOutputTokens === undefined ? {} : { appliedMaxOutputTokens: input.appliedMaxOutputTokens }),
      } });
      if (expiresSeconds !== undefined) {
        const expires = expiresSeconds;
        actions.push({ kind: "Put", table: this.#markers, item: { pk, sk: INFLIGHT, owner: id, expiresSeconds: expires, expiresAt: expires },
          condition: (e) => `attribute_not_exists(${e.name("pk")}) OR ${e.name("expiresSeconds")} <= ${e.value(clock)}` });
      }
      try { await this.#db.transact(actions, randomUUID()); }
      catch (error) {
        if (error instanceof TransactionRefused) continue;
        // Outcome unknown even after the same-token retry: the hold itself says whether it applied. If it did, the call
        // goes ahead on it (and is settled as usual), so no applied hold is left without an owner.
        let applied: Item | undefined;
        try { applied = await this.#db.get(this.#t.meter, { pk, sk: `HOLD#${id}` }); } catch { return { ok: false, reason: "busy" }; }
        if (applied === undefined) return { ok: false, reason: "busy" };
      }
      const reservation = Object.freeze({ id, ...(input.appliedMaxOutputTokens === undefined ? {} : { appliedMaxOutputTokens: input.appliedMaxOutputTokens }) });
      this.#holds.set(reservation, { pk, id });
      return { ok: true, reservation };
    }
    return { ok: false, reason: "busy" };
  }

  async settle(reservation: Reservation, actualMicros: number, estimated?: EstimatedSettlement): Promise<void> {
    if (record(reservation) === undefined || typeof reservation.id !== "string") throw new Error("settlement unavailable");
    await this.#beforeWrite("settle");
    const where = this.#holds.get(reservation);
    if (where === undefined || where.id !== reservation.id) return; // Not a reservation of this meter: nothing to close.
    const { pk, id } = where;
    const hold = readHold(await this.#db.get(this.#t.meter, { pk, sk: `HOLD#${id}` }), this.#combined !== undefined);
    if (hold === undefined || hold.status !== "open") return; // Already closed; ledger and rows stay untouched.
    if (!whole(actualMicros)) throw new Error("settlement unavailable");
    if (estimated !== undefined && (!validEntry({ ...estimated, inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }) || !whole(estimated.settledAt) || (estimated.priceVersion !== undefined && !whole(estimated.priceVersion)) || (estimated.usage !== undefined && !validUsage(estimated.usage)) || actualMicros < 1)) throw new Error("settlement unavailable");
    await this.#close(pk, id, hold, actualMicros, estimated, false);
  }

  /**
   * One hold to spend, in one conditional transaction (the hold must still be open). `swept`: closed by the sweep at the hold's
   * own estimate because its call's settle never landed; counted as estimated, never at $0.
   */
  async #close(pk: string, id: string, hold: Hold, actualMicros: number, estimated: EstimatedSettlement | undefined, swept: boolean): Promise<"closed" | "already"> {
    const extraEstimated = estimated === undefined && !swept ? 0 : actualMicros;
    const callKey = JSON.stringify([hold.scope.iss, hold.scope.cid, id]);
    const now = this.#now();
    const pending = estimated?.usage !== undefined && hasUsage(estimated.usage);
    const ledger: Item = {
      pk, sk: `CALL#${id}`, callKey, ...scopeFields(hold.scope), month: hold.month, settledMicros: actualMicros, estimated: estimated !== undefined || swept, targets: targetsPlain(hold.targets),
      ...(swept ? { swept: true } : {}),
      settledAt: pending ? estimated.settledAt : now,
      ...(!pending ? {} : {
        provider: estimated.provider, model: estimated.model, kind: estimated.kind, usage: usagePlain(estimated.usage!), status: "pending",
        ...(estimated.priceVersion === undefined ? {} : { priceVersion: estimated.priceVersion }),
        pendingAll: GATEWAY_PENDING_PARTITION, pendingKeyAt: pendingKeyAt(priceKey(estimated), estimated.settledAt, callKey), pendingAt: pendingAt(estimated.settledAt, callKey),
      }),
    };
    const holdIndex = hold.targets.length; const ledgerIndex = holdIndex + 1;
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      if (attempt > 0) await backoff(attempt);
      const stored = await this.#rows(pk, hold.targets);
      const actions: TransactAction[] = hold.targets.map((target, i): TransactAction => {
        const row = rowOf(stored[i], target, hold.scope.cid);
        if (stored[i] === undefined || row.company !== hold.scope.cid || ![row.committed - hold.estimate + actualMicros, row.spentMicros + actualMicros, row.estimatedMicros + extraEstimated].every(whole) || row.reservedMicros < hold.estimate) throw new Error("settlement unavailable");
        const overrun = target.cap !== undefined && row.spentMicros + actualMicros > target.cap;
        const delta = actualMicros - hold.estimate;
        return { kind: "Update", table: this.#table(target), key: { pk, sk: target.sk },
          update: (e) => `SET ${e.name("spentMicros")} = ${e.name("spentMicros")} + ${e.value(actualMicros)}, ${e.name("estimatedMicros")} = ${e.name("estimatedMicros")} + ${e.value(extraEstimated)}, ${e.name("reservedMicros")} = ${e.name("reservedMicros")} - ${e.value(hold.estimate)}, ${e.name("committed")} = ${e.name("committed")} + ${e.value(delta)}${overrun ? `, ${e.name("overrun")} = ${e.value(true)}` : ""}`,
          // Bounds that keep every value a whole safe integer; and, when this settle does not set the overrun flag, that a
          // concurrent settle has not pushed the row past its cap meanwhile (then this one re-reads and sets it).
          condition: (e) => [
            `${e.name("company")} = ${e.value(hold.scope.cid)}`, `${e.name("reservedMicros")} >= ${e.value(hold.estimate)}`,
            `${e.name("spentMicros")} <= ${e.value(MAX - actualMicros)}`, `${e.name("estimatedMicros")} <= ${e.value(MAX - extraEstimated)}`,
            `${e.name("committed")} >= ${e.value(Math.max(0, -delta))}`, `${e.name("committed")} <= ${e.value(MAX - Math.max(0, delta))}`,
            ...(overrun || target.cap === undefined ? [] : [`${e.name("spentMicros")} <= ${e.value(target.cap - actualMicros)}`]),
          ].join(" AND ") };
      });
      actions.push({ kind: "Update", table: this.#t.meter, key: { pk, sk: `HOLD#${id}` },
        update: (e) => `SET ${e.name("status")} = ${e.value("settled")}, ${e.name("actualMicros")} = ${e.value(actualMicros)}, ${e.name("closedAt")} = ${e.value(now)}${swept ? `, ${e.name("swept")} = ${e.value(true)}` : ""} REMOVE ${e.name("openAll")}, ${e.name("openAt")}`,
        condition: (e) => `${e.name("status")} = ${e.value("open")}` });
      actions.push({ kind: "Put", table: this.#t.ledger, item: ledger, condition: (e) => `attribute_not_exists(${e.name("pk")})` });
      try { await this.#db.transact(actions, randomUUID()); }
      catch (error) {
        if (!(error instanceof TransactionRefused)) throw new Error("settlement unavailable", { cause: error });
        if (error.conditionFailed(holdIndex) || error.conditionFailed(ledgerIndex)) return "already"; // Closed by another settle.
        continue;
      }
      // The marker goes only if this reservation still owns it; a crash here leaves it to expire (at most the token's lifetime).
      try { await this.#db.delete(this.#markers, { pk, sk: INFLIGHT }, (e) => `${e.name("owner")} = ${e.value(id)}`); } catch { /* It expires. */ }
      return "closed";
    }
    throw new Error("settlement unavailable");
  }

  /**
   * Closes holds left open past HOLD_SWEEP_AGE_MS (their call's settle failed, or its process stopped): each is settled at its
   * own reserved estimate (at least 1 micro-dollar, never $0, DEC 172), marked estimated and swept, in the same conditional
   * transaction as a settle, so a late settle and the sweep cannot both apply. Bounded: at most `limit` holds per run, oldest first.
   */
  async sweepOpenHolds(now: number, limit: number): Promise<{ swept: number; already: number; failed: number; more: boolean }> {
    if (!whole(now) || !whole(limit) || limit < 1 || limit > HOLD_SWEEP_MAX) throw new Error("sweep unavailable");
    const before = now - HOLD_SWEEP_AGE_MS;
    const report = { swept: 0, already: 0, failed: 0, more: false };
    if (before <= 0) return report;
    const index = GATEWAY_METER_INDEXES.openHolds;
    // Resume after the last hold this meter looked at, so holds that cannot be closed never block newer ones; a pass that
    // reaches the end starts again from the oldest.
    const after = this.#sweepAfter !== undefined && this.#sweepAfter < pad(before) ? this.#sweepAfter : undefined;
    const found = (await this.#db.query(this.#t.meter, { index: index.name, limit: limit + 2, key: (e) => after === undefined
      ? `${e.name(index.partitionKey)} = ${e.value(GATEWAY_OPEN_PARTITION)} AND ${e.name(index.sortKey)} < ${e.value(pad(before))}`
      : `${e.name(index.partitionKey)} = ${e.value(GATEWAY_OPEN_PARTITION)} AND ${e.name(index.sortKey)} BETWEEN ${e.value(after)} AND ${e.value(pad(before))}` }))
      .filter((item) => item.openAt !== after);
    report.more = found.length > limit;
    const page = found.slice(0, limit);
    const last = page.at(-1)?.openAt;
    this.#sweepAfter = report.more && typeof last === "string" ? last : undefined;
    for (const item of page) {
      try {
        if (typeof item.pk !== "string" || !item.pk.startsWith(GATEWAY_COMPANY_KEY_PREFIX) || typeof item.sk !== "string" || !/^HOLD#[0-9a-f-]{36}$/u.test(item.sk) || !whole(item.createdAt) || item.createdAt >= before || (item.openFrom !== undefined && (!whole(item.openFrom) || item.openFrom >= before))) { report.failed++; continue; }
        const id = item.sk.slice("HOLD#".length);
        // Re-read consistently: the index is eventually consistent, the decision is made from the table.
        const hold = readHold(await this.#db.get(this.#t.meter, { pk: item.pk, sk: item.sk }), this.#combined !== undefined);
        if (hold === undefined || hold.status !== "open" || companyPartition(hold.scope.iss, hold.scope.cid) !== item.pk) { report.already++; continue; }
        const result = await this.#close(item.pk, id, hold, Math.max(1, hold.estimate), undefined, true);
        if (result === "closed") report.swept++; else report.already++;
      } catch { report.failed++; report.more = true; }
    }
    return report;
  }

  async #beforeTransaction(operation: "correct" | "expire", input: ExpiryInput, rows?: MeterRow[]): Promise<boolean> {
    if (input.signal?.aborted) return false;
    let abort!: () => void;
    const stopped = new Promise<false>((resolve) => { abort = () => resolve(false); });
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, CORRECTION_RUN_MS);
    try {
      const ready = await Promise.race([Promise.resolve(this.#beforeWrite(operation, rows)).then(() => true), stopped]);
      return ready && !input.signal?.aborted;
    } catch { return false; }
    finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
  }
  #validTransaction(input: unknown): input is ExpiryInput {
    const v = record(input);
    return v !== undefined && typeof v.callKey === "string" && v.callKey.length > 0 && v.callKey.length <= 4096 && whole(v.now) && typeof v.runId === "string" && v.runId.length > 0 && v.runId.length <= 512 && (v.signal === undefined || v.signal instanceof AbortSignal);
  }
  /** One write bounded by the caller's signal and CORRECTION_RUN_MS: a result never acknowledged is "unknown". */
  #bounded(signal: AbortSignal | undefined): { signal: AbortSignal; done(): void } {
    const controller = new AbortController(); const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(abort, CORRECTION_RUN_MS);
    return { signal: controller.signal, done: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
  }
  /** Leaving pending: the call drops out of both pending indexes. */
  #closePending(e: Expr): string { return `REMOVE ${e.name("pendingAll")}, ${e.name("pendingKeyAt")}, ${e.name("pendingAt")}`; }

  async expire(input: ExpiryInput): Promise<CorrectionResult> {
    if (!this.#validTransaction(input)) return { status: "busy" };
    if (!await this.#beforeTransaction("expire", input) || input.signal?.aborted) return { status: "unknown" };
    const where = parseCallKey(input.callKey); if (where === undefined) return { status: "missing" };
    const bound = this.#bounded(input.signal);
    try {
      let item: Item | undefined;
      try { item = await this.#db.get(this.#t.ledger, where, { signal: bound.signal }); } catch { return { status: "unknown" }; }
      if (item === undefined || item.status === undefined) return { status: "missing" };
      if (item.status !== "pending") return { status: "already" };
      if (!whole(item.settledAt) || input.now - item.settledAt <= PENDING_RETENTION_DAYS * DAY_MS) return { status: "busy" };
      const applied = await this.#db.update(this.#t.ledger, where,
        (e) => `SET ${e.name("status")} = ${e.value("expired")}, ${e.name("expiredAt")} = ${e.value(input.now)}, ${e.name("runId")} = ${e.value(input.runId)} ${this.#closePending(e)}`,
        (e) => `${e.name("status")} = ${e.value("pending")}`, { signal: bound.signal });
      return applied ? { status: "expired" } : { status: "already" };
    } catch { return { status: "unknown" }; }
    finally { bound.done(); }
  }

  async correct(input: CorrectionInput): Promise<CorrectionResult> {
    const origin = record(record(input)?.priceSource);
    if (!this.#validTransaction(input) || (input.priceVersion !== undefined && (!whole(input.priceVersion) || typeof input.estimated !== "boolean")) || (input.estimated !== undefined && (!whole(input.priceVersion) || typeof input.estimated !== "boolean")) || !whole(input.realMicros) || input.realMicros < 1 || !validCaps(input.caps) || !whole(input.now) || typeof input.runId !== "string" || input.runId.length === 0 || input.runId.length > 512 || origin === undefined || typeof origin.source !== "string" || !["litellm", "aws", "override"].includes(origin.source) || !whole(origin.fetchedAt)) return { status: "busy" };
    const where = parseCallKey(input.callKey);
    let observedRows: MeterRow[] | undefined;
    if (where !== undefined) {
      try {
        const observed = await this.#db.get(this.#t.ledger, where);
        const targets = observed === undefined ? undefined : readTargets(observed.targets, this.#combined !== undefined);
        if (targets !== undefined) observedRows = (await this.#rows(where.pk, targets)).map((row, i) => rowOf(row, targets[i]!, where.cid));
      } catch { observedRows = undefined; }
    }
    if (!await this.#beforeTransaction("correct", input, observedRows) || input.signal?.aborted) return { status: "unknown" };
    if (where === undefined) return { status: "missing" };
    const bound = this.#bounded(input.signal);
    try {
      // Re-read after the hook: every decision below is from this read, and the transaction applies only if it still holds.
      let item: Item | undefined;
      try { item = await this.#db.get(this.#t.ledger, where, { signal: bound.signal }); } catch { return { status: "unknown" }; }
      if (item === undefined || item.status === undefined) return { status: "missing" };
      if (item.status !== "pending") return { status: "already" };
      let call: EstimatedCall; const targets = readTargets(item.targets, this.#combined !== undefined);
      try { call = toCall(item); } catch { return { status: "busy" }; }
      if (targets === undefined || call.cid !== where.cid || call.iss !== where.iss) return { status: "busy" };
      const expire = input.now - call.settledAt > PENDING_RETENTION_DAYS * DAY_MS;
      if (!expire && (input.priceVersion ?? 0) <= (call.priceVersion ?? 0)) return { status: "already" };
      const ledgerGuard = (e: Expr) => [`${e.name("status")} = ${e.value("pending")}`, `${e.name("settledMicros")} = ${e.value(call.settledMicros)}`,
        call.priceVersion === undefined ? `attribute_not_exists(${e.name("priceVersion")})` : `${e.name("priceVersion")} = ${e.value(call.priceVersion)}`].join(" AND ");
      if (expire) {
        const applied = await this.#db.update(this.#t.ledger, where,
          (e) => `SET ${e.name("status")} = ${e.value("expired")}, ${e.name("expiredAt")} = ${e.value(input.now)}, ${e.name("runId")} = ${e.value(input.runId)} ${this.#closePending(e)}`,
          ledgerGuard, { signal: bound.signal });
        return applied ? { status: "expired" } : { status: "busy" };
      }
      const deltaMicros = input.realMicros - call.settledMicros;
      const estimatedDelta = input.estimated === true ? deltaMicros : -call.settledMicros;
      let capExceeded = false;
      // A settle in the same company between this read and the write moves the rows: re-read and try again (bounded).
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) await backoff(attempt);
        if (bound.signal.aborted) return { status: "unknown" };
        let stored: Array<Item | undefined>;
        try { stored = await this.#rows(where.pk, targets); } catch { return { status: "unknown" }; }
        const rows: MeterRow[] = [];
        for (const [i, target] of targets.entries()) {
          let row: MeterRow; try { row = rowOf(stored[i], target, call.cid); } catch { return { status: "busy" }; }
          if (stored[i] === undefined || row.company !== call.cid || ![row.spentMicros + deltaMicros, row.committed + deltaMicros, row.estimatedMicros + estimatedDelta].every((value) => whole(value) && value < MAX) || row.estimatedMicros + estimatedDelta > row.spentMicros + deltaMicros) return { status: "busy" };
          rows.push(row);
        }
        const capFor = { task: input.caps.task, person: input.caps.personMonth, project: input.caps.projectMonth, company: input.caps.companyMonth };
        capExceeded = false;
        const actions: TransactAction[] = targets.map((target, i): TransactAction => {
          const row = rows[i]!; const spentMicros = row.spentMicros + deltaMicros; const cap = target.combined === true ? input.caps.combinedCompanyMonth : capFor[target.item];
          if (deltaMicros > 0 && cap !== undefined && row.committed + deltaMicros > cap) capExceeded = true;
          return { kind: "Update", table: this.#table(target), key: { pk: where.pk, sk: target.sk },
            update: (e) => `SET ${e.name("spentMicros")} = ${e.name("spentMicros")} + ${e.value(deltaMicros)}, ${e.name("committed")} = ${e.name("committed")} + ${e.value(deltaMicros)}, ${e.name("estimatedMicros")} = ${e.name("estimatedMicros")} + ${e.value(estimatedDelta)}${cap === undefined ? "" : `, ${e.name("overrun")} = ${e.value(spentMicros > cap)}`}`,
            // The spend and estimated parts as read (so the overrun flag and the estimated <= spent rule hold); committed may
            // have moved with other calls' holds, but stays a whole safe integer.
            condition: (e) => [`${e.name("company")} = ${e.value(call.cid)}`, `${e.name("spentMicros")} = ${e.value(row.spentMicros)}`, `${e.name("estimatedMicros")} = ${e.value(row.estimatedMicros)}`,
              `${e.name("committed")} >= ${e.value(Math.max(0, -deltaMicros))}`, `${e.name("committed")} < ${e.value(MAX - Math.max(0, deltaMicros))}`].join(" AND ") };
        });
        const stillPending = input.estimated === true;
        actions.push({ kind: "Update", table: this.#t.ledger, key: where, condition: ledgerGuard,
          update: (e) => `SET ${[
            `${e.name("status")} = ${e.value(stillPending ? "pending" : "corrected")}`, `${e.name("settledMicros")} = ${e.value(input.realMicros)}`,
            ...(input.priceVersion === undefined ? [] : [`${e.name("priceVersion")} = ${e.value(input.priceVersion)}`]),
            `${e.name("correctedFrom")} = ${e.value(call.settledMicros)}`, `${e.name("correctedTo")} = ${e.value(input.realMicros)}`, `${e.name("deltaMicros")} = ${e.value(deltaMicros)}`,
            `${e.name("correctedAt")} = ${e.value(input.now)}`, `${e.name("runId")} = ${e.value(input.runId)}`,
            `${e.name("priceSource")} = ${e.value({ source: origin.source as string, fetchedAt: origin.fetchedAt as number })}`,
            ...(capExceeded ? [`${e.name("capExceeded")} = ${e.value(true)}`] : []),
          ].join(", ")}${stillPending ? "" : ` ${this.#closePending(e)}`}` });
        try { await this.#db.transact(actions, randomUUID(), { signal: bound.signal }); }
        catch (error) {
          if (!(error instanceof TransactionRefused)) return { status: "unknown" };
          // The ledger row moved (another run corrected it) or the retries are spent: busy, retried by a later run.
          if (error.conditionFailed(targets.length) || attempt + 1 >= CORRECT_ATTEMPTS) return { status: "busy" };
          continue;
        }
        break;
      }
      return { status: "corrected", deltaMicros, ...(capExceeded ? { capExceeded: true } : {}) };
    } catch { return { status: "unknown" }; }
    finally { bound.done(); }
  }

  /** Distinct price keys with a pending call, in price-key order. The cursor is the last key handed out. */
  async pendingKeys(limit: number, cursor?: string): Promise<PendingPage<PriceKey>> {
    if (!whole(limit) || limit < 1 || limit > CORRECTION_RUN_MAX) throw new Error("pending unavailable");
    let after = " ";
    if (cursor !== undefined) {
      let parsed: unknown; try { if (typeof cursor !== "string" || cursor.length > 8192) throw new Error(); parsed = JSON.parse(cursor); } catch { throw new Error("pending unavailable"); }
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== "keys" || typeof parsed[1] !== "string" || parsed[1].length === 0) throw new Error("pending unavailable");
      // "}" sorts after the "|" that ends every index value of that key, and a key's JSON is never a prefix of another's.
      after = `${parsed[1]}}`;
    }
    const index = GATEWAY_LEDGER_INDEXES.pendingByKey;
    const next = async (): Promise<PriceKey | undefined> => {
      const [item] = await this.#db.query(this.#t.ledger, { index: index.name, limit: 1, key: (e) => `${e.name(index.partitionKey)} = ${e.value(GATEWAY_PENDING_PARTITION)} AND ${e.name(index.sortKey)} > ${e.value(after)}` });
      if (item === undefined) return undefined;
      if (typeof item.provider !== "string" || typeof item.model !== "string" || typeof item.pendingKeyAt !== "string") throw new Error("pending unavailable");
      const key = { provider: item.provider, model: item.model };
      if (!item.pendingKeyAt.startsWith(`${priceKey(key)}|`)) throw new Error("pending unavailable");
      after = `${priceKey(key)}}`; return key;
    };
    const items: PriceKey[] = [];
    while (items.length < limit) { const key = await next(); if (key === undefined) return { items }; items.push(key); }
    const more = await next();
    return { items, ...(more === undefined ? {} : { cursor: JSON.stringify(["keys", priceKey(items.at(-1)!)]) }) };
  }

  async pendingFor(key: PriceKey, limit: number, cursor?: string): Promise<PendingPage<EstimatedCall>> {
    if (!validEntry({ ...key, kind: "chat", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 })) throw new Error("pending unavailable");
    if (!whole(limit) || limit < 1 || limit > CORRECTION_RUN_MAX) throw new Error("pending unavailable");
    const id = priceKey(key);
    const position = parsePosition(cursor, id);
    const after = position === undefined ? `${id}|` : pendingKeyAt(id, position[0], position[1]);
    const index = GATEWAY_LEDGER_INDEXES.pendingByKey;
    const found = await this.#db.query(this.#t.ledger, { index: index.name, limit: limit + 1, key: (e) => `${e.name(index.partitionKey)} = ${e.value(GATEWAY_PENDING_PARTITION)} AND ${e.name(index.sortKey)} > ${e.value(after)}` });
    const mine = found.filter((item) => typeof item.pendingKeyAt === "string" && item.pendingKeyAt.startsWith(`${id}|`)).map(toCall);
    const items = mine.slice(0, limit); const last = items.at(-1);
    return { items, ...(mine.length > limit && last !== undefined ? { cursor: JSON.stringify([id, last.settledAt, last.callKey]) } : {}) };
  }

  async pendingExpired(now: number, limit: number, cursor?: string): Promise<PendingPage<EstimatedCall>> {
    if (!whole(now) || !whole(limit) || limit < 1 || limit > CORRECTION_RUN_MAX) throw new Error("pending unavailable");
    const before = now - PENDING_RETENTION_DAYS * DAY_MS;
    const position = parsePosition(cursor, "expiry");
    if (before <= 0 || (position !== undefined && position[0] >= before)) return { items: [] };
    const index = GATEWAY_LEDGER_INDEXES.pendingByAge;
    const low = position === undefined ? undefined : pendingAt(position[0], position[1]);
    // pad(before) sorts below every value at that millisecond, so BETWEEN/< keep settledAt < before only.
    const found = await this.#db.query(this.#t.ledger, { index: index.name, limit: limit + 2, key: (e) => low === undefined
      ? `${e.name(index.partitionKey)} = ${e.value(GATEWAY_PENDING_PARTITION)} AND ${e.name(index.sortKey)} < ${e.value(pad(before))}`
      : `${e.name(index.partitionKey)} = ${e.value(GATEWAY_PENDING_PARTITION)} AND ${e.name(index.sortKey)} BETWEEN ${e.value(low)} AND ${e.value(pad(before))}` });
    const calls = found.filter((item) => item.pendingAt !== low).map(toCall).filter((call) => call.settledAt < before);
    const items = calls.slice(0, limit); const last = items.at(-1);
    return { items, ...(calls.length > limit && last !== undefined ? { cursor: JSON.stringify(["expiry", last.settledAt, last.callKey]) } : {}) };
  }

  async read(scope: MeterScope): Promise<readonly MeterRow[]> {
    if (!validScope(scope)) throw new Error("meter unavailable");
    const pk = companyPartition(scope.iss, scope.cid);
    const targets = targetsFor(scope, { task: 0, projectMonth: 0 }, this.#month());
    const stored = await this.#rows(pk, targets);
    return targets.map((target, i) => rowOf(stored[i], target, scope.cid));
  }
}

function parsePosition(cursor: string | undefined, scope: string): readonly [number, string] | undefined {
  if (cursor === undefined) return undefined;
  let parsed: unknown;
  try { if (typeof cursor !== "string" || cursor.length > 8192) throw new Error(); parsed = JSON.parse(cursor); } catch { throw new Error("pending unavailable"); }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== scope || !whole(parsed[1]) || typeof parsed[2] !== "string" || parsed[2].length === 0 || parsed[2].length > 4096) throw new Error("pending unavailable");
  return [parsed[1], parsed[2]];
}

/** The ended-task list in the markers table. A read that fails throws, and the server stops the call (fail closed). */
export class DynamoEndedTasks implements EndedTasks {
  constructor(private readonly db: Dynamo, private readonly table: string) {}
  async isEnded(issuer: string, company: string, task: string, signal?: AbortSignal): Promise<boolean> {
    if (typeof issuer !== "string" || issuer.length === 0 || issuer.length > 2048 || !COMPANY.test(company) || !TASK.test(task)) throw new AwsNotSentError();
    const item = await this.db.get(this.table, { pk: companyPartition(issuer, company), sk: `ENDED#${task}` }, { consistent: false, ...(signal === undefined ? {} : { signal }) });
    return item !== undefined;
  }
}
