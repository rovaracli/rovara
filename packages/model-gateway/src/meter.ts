import { PENDING_RETENTION_DAYS, DAY_MS, CORRECTION_RUN_MAX } from "./price-constants.js";
import { hasUsage, validUsage } from "./reported-cost.js";
import type { TokenUsage } from "./usage.js";
import type { PriceKind, PriceOrigin } from "./price.js";
import { priceKey, validEntry, type PriceKey } from "./price-snapshot.js";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { validCaps, type Caps } from "./caps.js";
import { COMPANY, PERSON, PROJECT, TASK, TASK_TOKEN_SECONDS, record, whole } from "./model-gateway-token.js";
export interface MeterScope { iss: string; cid: string; pid: string; tid: string; per?: string }
export type MeterItem = "task" | "person" | "project" | "company";
export interface MeterRow { item: MeterItem; company: string; spentMicros: number; estimatedMicros: number; reservedMicros: number; committed: number; overrun: boolean }
export interface Reservation { readonly id: string; readonly appliedMaxOutputTokens?: number }
export type ReserveResult = { ok: true; reservation: Reservation } | { ok: false; reason: "cap" | "overrun"; item: MeterItem; held: boolean } | { ok: false; reason: "busy"; overrunInFlight?: true };
export interface ReserveInput {
  scope: MeterScope; caps: Caps; estimateMicros: number; appliedMaxOutputTokens?: number;
  /** Omit only when usage is bounded by the priced hold. All times are integer seconds. */
  overrun?: { deadlineSeconds: number; tokenExpiresSeconds: number };
}
export interface Meter {
  reserve(input: ReserveInput): Promise<ReserveResult>;
  settle(reservation: Reservation, actualMicros: number, estimated?: EstimatedSettlement): Promise<void>;
  pendingKeys(limit: number): Promise<PriceKey[]>;
  pendingFor(key: PriceKey, limit: number): Promise<EstimatedCall[]>;
  correct(input: CorrectionInput): Promise<CorrectionResult>;
  read(scope: MeterScope): Promise<readonly MeterRow[]>;
}
export interface EstimatedSettlement { provider: string; model: string; kind: PriceKind; usage?: TokenUsage; settledAt: number }
export interface EstimatedCall extends MeterScope {
  callKey: string; month: string; provider: string; model: string; kind: PriceKind; usage: TokenUsage;
  settledMicros: number; status: "pending" | "corrected" | "expired"; settledAt: number;
  correctedFrom?: number; correctedTo?: number; deltaMicros?: number; correctedAt?: number; expiredAt?: number; runId?: string; priceSource?: PriceOrigin;
}
export interface CorrectionInput { callKey: string; realMicros: number; caps: Caps; priceSource: PriceOrigin; runId: string; now: number }
export type CorrectionResult = { status: "corrected"; deltaMicros: number } | { status: "already" | "missing" | "expired" | "busy" };
export function costView(rows: readonly MeterRow[]): Array<{ item: MeterItem; spentMicros: number; estimated: boolean }> {
  return rows.map((row) => ({ item: row.item, spentMicros: row.spentMicros, estimated: row.estimatedMicros > 0 }));
}
interface Target { key: string; item: MeterItem; cap: number | undefined }
interface Open { month: string; appliedMaxOutputTokens?: number; scope: MeterScope; estimate: number; targets: Target[] }
function validScope(value: unknown): value is MeterScope {
  const s = record(value);
  return s !== undefined && typeof s.iss === "string" && s.iss.length > 0 && s.iss.length <= 2048 && typeof s.cid === "string" && COMPANY.test(s.cid) && typeof s.pid === "string" && PROJECT.test(s.pid) && typeof s.tid === "string" && TASK.test(s.tid) && (s.per === undefined || (typeof s.per === "string" && PERSON.test(s.per)));
}
function targets(scope: MeterScope, caps: Caps, month: string): Target[] {
  const key = (kind: MeterItem, ...parts: string[]) => JSON.stringify([scope.iss, scope.cid, kind, ...parts]);
  return [
    { key: key("task", scope.tid), item: "task", cap: caps.task },
    ...(scope.per === undefined ? [] : [{ key: key("person", scope.per, month), item: "person" as const, cap: caps.personMonth }]),
    { key: key("project", scope.pid, month), item: "project", cap: caps.projectMonth },
    { key: key("company", month), item: "company", cap: caps.companyMonth },
  ];
}
/** Conditional transaction fake: no await between checking all rows and writing all rows. Conflict hook writes nothing. */
export class InMemoryMeter implements Meter {
  readonly #rows = new Map<string, MeterRow>();
  readonly #open = new Map<string, Open>();
  readonly #ledger = new Map<string, { call: EstimatedCall; targets: Target[] }>();
  readonly #pending = new Map<string, string[]>();
  readonly #keyOrder: string[] = [];
  readonly #inFlight = new Map<string, { owner: string; expiresSeconds: number }>();
  constructor(private readonly now: () => number = Date.now, private readonly conflict: () => boolean = () => false, private readonly beforeWrite: (operation: "settle" | "correct", rows?: MeterRow[]) => void | Promise<void> = () => undefined) {}
  #month(): string { return new Date(this.now()).toISOString().slice(0, 7); }
  #row(target: Target, scope: MeterScope): MeterRow { return this.#rows.get(target.key) ?? { item: target.item, company: scope.cid, spentMicros: 0, estimatedMicros: 0, reservedMicros: 0, committed: 0, overrun: false }; }
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    if (record(input) === undefined || !validScope(input.scope) || !validCaps(input.caps) || !whole(input.estimateMicros)) return { ok: false, reason: "busy" };
    const { scope, caps, estimateMicros } = input;
    if (input.appliedMaxOutputTokens !== undefined && (!whole(input.appliedMaxOutputTokens) || input.appliedMaxOutputTokens < 1)) return { ok: false, reason: "busy" };
    const clock = Math.floor(this.now() / 1000);
    let expiresSeconds: number | undefined;
    if (input.overrun !== undefined) {
      const marker = record(input.overrun);
      if (marker === undefined || !whole(marker.deadlineSeconds) || !whole(marker.tokenExpiresSeconds)) return { ok: false, reason: "busy" };
      expiresSeconds = Math.min(marker.deadlineSeconds, marker.tokenExpiresSeconds, clock + TASK_TOKEN_SECONDS);
      if (expiresSeconds <= clock) return { ok: false, reason: "busy" };
    }
    const companyKey = JSON.stringify([scope.iss, scope.cid]);
    const month = this.#month();
    const items = targets(scope, caps, month);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.conflict()) continue;
      let blocked: Extract<ReserveResult, { reason: "cap" | "overrun" }> | undefined;
      for (const target of items) {
        const row = this.#row(target, scope);
        if (row.company !== scope.cid) return { ok: false, reason: "busy" };
        if (row.overrun) return { ok: false, reason: "overrun", item: target.item, held: false };
        if (!Number.isSafeInteger(row.committed + estimateMicros)) return { ok: false, reason: "busy" };
        if (target.cap !== undefined && (target.cap - estimateMicros < 0 || row.committed > target.cap - estimateMicros)) {
          const held = row.spentMicros <= target.cap - estimateMicros;
          // A permanent cap refusal takes precedence over a temporary hold on another item.
          if (blocked === undefined || !held) blocked = { ok: false, reason: "cap", item: target.item, held };
        }
      }
      if (blocked !== undefined) return blocked;
      const marker = this.#inFlight.get(companyKey);
      // Expiry frees ONLY the concurrency marker. Open reservations and their rows stay.
      if (marker !== undefined && marker.expiresSeconds <= clock) this.#inFlight.delete(companyKey);
      if (expiresSeconds !== undefined && this.#inFlight.has(companyKey)) return { ok: false, reason: "busy", overrunInFlight: true };
      const reservation = Object.freeze({ id: randomUUID(), ...(input.appliedMaxOutputTokens === undefined ? {} : { appliedMaxOutputTokens: input.appliedMaxOutputTokens }) });
      for (const target of items) { const row = this.#row(target, scope); this.#rows.set(target.key, { ...row, reservedMicros: row.reservedMicros + estimateMicros, committed: row.committed + estimateMicros }); }
      if (expiresSeconds !== undefined) this.#inFlight.set(companyKey, { owner: reservation.id, expiresSeconds });
      this.#open.set(reservation.id, { month, ...(input.appliedMaxOutputTokens === undefined ? {} : { appliedMaxOutputTokens: input.appliedMaxOutputTokens }), scope: { ...scope }, estimate: estimateMicros, targets: items });
      return { ok: true, reservation };
    }
    return { ok: false, reason: "busy" };
  }
  async settle(reservation: Reservation, actualMicros: number, estimated?: EstimatedSettlement): Promise<void> {
    if (record(reservation) === undefined || typeof reservation.id !== "string") throw new Error("settlement unavailable");
    await this.beforeWrite("settle");
    const open = this.#open.get(reservation.id);
    if (open === undefined) return; // Already closed; ledger and rows stay untouched.
    if (!whole(actualMicros)) throw new Error("settlement unavailable");
    if (estimated !== undefined && (!validEntry({ ...estimated, inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }) || !whole(estimated.settledAt) || (estimated.usage !== undefined && !validUsage(estimated.usage)) || actualMicros < 1)) throw new Error("settlement unavailable");
    const extraEstimated = estimated === undefined ? 0 : actualMicros;
    // All validation, ledger insertion and row writes below are one synchronous transaction.
    for (const t of open.targets) {
      const row = this.#row(t, open.scope);
      if (![row.committed - open.estimate + actualMicros, row.spentMicros + actualMicros, row.estimatedMicros + extraEstimated].every(whole) || row.reservedMicros < open.estimate) throw new Error("settlement unavailable");
    }
    for (const target of open.targets) {
      const row = this.#row(target, open.scope); const spentMicros = row.spentMicros + actualMicros;
      this.#rows.set(target.key, { ...row, spentMicros, estimatedMicros: row.estimatedMicros + extraEstimated, reservedMicros: row.reservedMicros - open.estimate, committed: row.committed - open.estimate + actualMicros, overrun: row.overrun || (target.cap !== undefined && spentMicros > target.cap) });
    }
    if (estimated?.usage !== undefined && hasUsage(estimated.usage)) {
      const callKey = JSON.stringify([open.scope.iss, open.scope.cid, reservation.id]);
      const call: EstimatedCall = { ...open.scope, callKey, month: open.month, provider: estimated.provider, model: estimated.model, kind: estimated.kind, usage: { ...estimated.usage }, settledAt: estimated.settledAt, settledMicros: actualMicros, status: "pending" };
      this.#ledger.set(callKey, { call, targets: open.targets.map((t) => ({ ...t })) });
      const key = priceKey(call); const pending = this.#pending.get(key) ?? [];
      // Keep oldest first at write time; reads take bounded prefixes without scanning the ledger.
      const index = pending.findIndex((id) => this.#ledger.get(id)!.call.settledAt > call.settledAt);
      pending.splice(index < 0 ? pending.length : index, 0, callKey); this.#pending.set(key, pending); this.#orderKey(key);
    }
    this.#open.delete(reservation.id);
    const companyKey = JSON.stringify([open.scope.iss, open.scope.cid]);
    if (this.#inFlight.get(companyKey)?.owner === reservation.id) this.#inFlight.delete(companyKey);
  }
  #orderKey(key: string): void {
    const previous = this.#keyOrder.indexOf(key); if (previous >= 0) this.#keyOrder.splice(previous, 1);
    const first = this.#pending.get(key)?.[0]; if (first === undefined) { this.#pending.delete(key); return; }
    const time = this.#ledger.get(first)!.call.settledAt;
    const at = this.#keyOrder.findIndex((k) => this.#ledger.get(this.#pending.get(k)![0]!)!.call.settledAt > time);
    this.#keyOrder.splice(at < 0 ? this.#keyOrder.length : at, 0, key);
  }
  async pendingKeys(limit: number): Promise<PriceKey[]> {
    if (!whole(limit) || limit < 1) return [];
    return this.#keyOrder.slice(0, Math.min(limit, CORRECTION_RUN_MAX + 1)).map((key) => {
      const call = this.#ledger.get(this.#pending.get(key)![0]!)!.call; return { provider: call.provider, model: call.model };
    });
  }
  async pendingFor(key: PriceKey, limit: number): Promise<EstimatedCall[]> {
    if (record(key) === undefined || typeof key.provider !== "string" || typeof key.model !== "string" || !whole(limit) || limit < 1) return [];
    return (this.#pending.get(priceKey(key)) ?? []).slice(0, Math.min(limit, CORRECTION_RUN_MAX + 1)).map((id) => structuredClone(this.#ledger.get(id)!.call));
  }
  ledger(callKey: string): EstimatedCall | undefined { const row = this.#ledger.get(callKey); return row === undefined ? undefined : structuredClone(row.call); }
  async correct(input: CorrectionInput): Promise<CorrectionResult> {
    const origin = record(record(input)?.priceSource);
    if (record(input) === undefined || typeof input.callKey !== "string" || !whole(input.realMicros) || input.realMicros < 1 || !validCaps(input.caps) || !whole(input.now) || typeof input.runId !== "string" || input.runId.length === 0 || input.runId.length > 512 || origin === undefined || !["litellm", "aws", "override"].includes(String(origin.source)) || !whole(origin.fetchedAt)) return { status: "busy" };
    const observed = this.#ledger.get(input.callKey);
    // Fake-adapter fault injection: the trusted hook can corrupt an item to prove underflow refusal.
    await this.beforeWrite("correct", observed?.targets.map((target) => this.#row(target, observed.call)));
    // Re-read after the race hook. No await until every row and the ledger have committed.
    const ledger = this.#ledger.get(input.callKey); if (ledger === undefined) return { status: "missing" };
    const { call } = ledger; if (call.status !== "pending") return { status: "already" };
    if (this.conflict()) return { status: "busy" };
    const expire = input.now - call.settledAt > PENDING_RETENTION_DAYS * DAY_MS;
    const deltaMicros = input.realMicros - call.settledMicros;
    if (!expire) {
      for (const target of ledger.targets) {
        const row = this.#row(target, call);
        if (row.company !== call.cid || ![row.spentMicros + deltaMicros, row.committed + deltaMicros, row.estimatedMicros - call.settledMicros].every(whole) || row.estimatedMicros - call.settledMicros > row.spentMicros + deltaMicros) return { status: "busy" };
      }
      const capFor = { task: input.caps.task, person: input.caps.personMonth, project: input.caps.projectMonth, company: input.caps.companyMonth };
      for (const target of ledger.targets) {
        const row = this.#row(target, call); const spentMicros = row.spentMicros + deltaMicros; const cap = capFor[target.item];
        this.#rows.set(target.key, { ...row, spentMicros, committed: row.committed + deltaMicros, estimatedMicros: row.estimatedMicros - call.settledMicros, overrun: cap === undefined ? row.overrun : spentMicros > cap });
      }
    }
    ledger.call = expire ? { ...call, status: "expired", expiredAt: input.now, runId: input.runId } : { ...call, status: "corrected", correctedFrom: call.settledMicros, correctedTo: input.realMicros, deltaMicros, correctedAt: input.now, runId: input.runId, priceSource: { ...input.priceSource } };
    const key = priceKey(call); const pending = this.#pending.get(key)!; pending.splice(pending.indexOf(input.callKey), 1); this.#orderKey(key);
    return expire ? { status: "expired" } : { status: "corrected", deltaMicros };
  }
  async read(scope: MeterScope): Promise<readonly MeterRow[]> {
    if (!validScope(scope)) throw new Error("meter unavailable");
    return targets(scope, { task: 0, projectMonth: 0 }, this.#month()).map((t) => ({ ...this.#row(t, scope) }));
  }
}
/** Adapter-neutral executable contract. No test runner dependency; adapters must also run conflict-injection proofs. */
export async function runMeterConformance(factory: (clock: () => number) => Meter): Promise<string[]> {
  const scope = { iss: "https://install.example/v1/auth", cid: `org_${"a".repeat(20)}`, pid: "web", tid: "task_1" };
  const caps = { task: 100, projectMonth: 100, companyMonth: 100 };
  let clock = Date.UTC(2026, 0, 1);
  const meter = factory(() => clock);
  const reserved = await meter.reserve({ scope, caps, estimateMicros: 60 }); assert(reserved.ok);
  assert((await meter.read(scope)).every((r) => r.reservedMicros === 60 && r.spentMicros === 0));
  assert(!(await meter.reserve({ scope, caps, estimateMicros: 60 })).ok);
  assert((await meter.read(scope)).every((r) => r.reservedMicros === 60));
  await meter.settle(reserved.reservation, 101);
  assert((await meter.read(scope)).every((r) => r.spentMicros === 101 && r.overrun));
  await meter.settle(reserved.reservation, 50); assert((await meter.read(scope)).every((r) => r.spentMicros === 101));
  assert(!(await meter.reserve({ scope: { ...scope, tid: "task_2" }, caps, estimateMicros: 1 })).ok);
  assert((await meter.reserve({ scope: { ...scope, cid: `org_${"b".repeat(20)}` }, caps, estimateMicros: 1 })).ok);
  assert(!(await meter.read(scope)).some((r) => r.item === "person"));
  const marked = factory(() => clock);
  const args = { scope, caps, estimateMicros: 40, overrun: { deadlineSeconds: clock / 1000 + 10, tokenExpiresSeconds: clock / 1000 + 900 } };
  const old = await marked.reserve(args); assert(old.ok);
  assert.deepEqual(await marked.reserve(args), { ok: false, reason: "busy", overrunInFlight: true });
  // A bounded priced call is not serialized behind an estimated call.
  const priced = await marked.reserve({ scope, caps, estimateMicros: 10 }); assert(priced.ok);
  await marked.settle(priced.reservation, 10);
  clock += 10_000;
  const newer = await marked.reserve({ ...args, overrun: { ...args.overrun, deadlineSeconds: clock / 1000 + 10 } }); assert(newer.ok);
  assert((await marked.read(scope)).every((r) => r.reservedMicros === 80 && r.spentMicros === 10));
  await marked.settle(old.reservation, 40);
  assert.deepEqual(await marked.reserve({ ...args, estimateMicros: 1, overrun: { ...args.overrun, deadlineSeconds: clock / 1000 + 10 } }), { ok: false, reason: "busy", overrunInFlight: true });
  await marked.settle(newer.reservation, 70);
  assert((await marked.read(scope)).every((r) => r.reservedMicros === 0 && r.spentMicros === 120 && r.overrun));
  const corrections = factory(() => clock);
  const e = await corrections.reserve({ scope, caps, estimateMicros: 90 }); assert(e.ok);
  await corrections.settle(e.reservation, 80, { provider: "anthropic", model: "model", kind: "chat", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, settledAt: clock });
  assert((await corrections.read(scope)).every((r) => r.estimatedMicros === 80));
  const pending = await corrections.pendingFor({ provider: "anthropic", model: "model" }, 10); assert.equal(pending.length, 1);
  const correction = { callKey: pending[0]!.callKey, realMicros: 20, caps, priceSource: { source: "litellm" as const, fetchedAt: clock }, runId: "conformance", now: clock };
  assert.deepEqual(await corrections.correct(correction), { status: "corrected", deltaMicros: -60 });
  assert.deepEqual(await corrections.correct(correction), { status: "already" });
  assert((await corrections.read(scope)).every((r) => r.spentMicros === 20 && r.estimatedMicros === 0 && r.committed === 20));
  assert((await corrections.reserve({ scope, caps, estimateMicros: 80 })).ok);
  return ["atomic estimated ledger", "idempotent correction", "correction frees budget", "one overrun in flight", "marker expiry keeps hold", "atomic hold", "cap subtraction", "no partial write", "overrun settle", "closed settle", "company ceiling", "isolation", "optional person"];
}
