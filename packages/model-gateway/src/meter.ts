import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { validCaps, type Caps } from "./caps.js";
import { COMPANY, PERSON, PROJECT, TASK, TASK_TOKEN_SECONDS, record, whole } from "./model-gateway-token.js";
export interface MeterScope { iss: string; cid: string; pid: string; tid: string; per?: string }
export type MeterItem = "task" | "person" | "project" | "company";
export interface MeterRow { item: MeterItem; company: string; spentMicros: number; reservedMicros: number; committed: number; overrun: boolean }
export interface Reservation { readonly id: string; readonly appliedMaxOutputTokens?: number }
export type ReserveResult = { ok: true; reservation: Reservation } | { ok: false; reason: "cap" | "overrun"; item: MeterItem; held: boolean } | { ok: false; reason: "busy"; overrunInFlight?: true };
export interface ReserveInput {
  scope: MeterScope; caps: Caps; estimateMicros: number; appliedMaxOutputTokens?: number;
  /** Omit only when usage is bounded by the priced hold. All times are integer seconds. */
  overrun?: { deadlineSeconds: number; tokenExpiresSeconds: number };
}
export interface Meter {
  reserve(input: ReserveInput): Promise<ReserveResult>;
  settle(reservation: Reservation, actualMicros: number): Promise<void>;
  read(scope: MeterScope): Promise<readonly MeterRow[]>;
}
interface Target { key: string; item: MeterItem; cap: number | undefined }
interface Open { appliedMaxOutputTokens?: number; scope: MeterScope; estimate: number; targets: Target[] }
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
  readonly #inFlight = new Map<string, { owner: string; expiresSeconds: number }>();
  constructor(private readonly now: () => number = Date.now, private readonly conflict: () => boolean = () => false) {}
  #month(): string { return new Date(this.now()).toISOString().slice(0, 7); }
  #row(target: Target, scope: MeterScope): MeterRow { return this.#rows.get(target.key) ?? { item: target.item, company: scope.cid, spentMicros: 0, reservedMicros: 0, committed: 0, overrun: false }; }
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
    const items = targets(scope, caps, this.#month());
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
      this.#open.set(reservation.id, { ...(input.appliedMaxOutputTokens === undefined ? {} : { appliedMaxOutputTokens: input.appliedMaxOutputTokens }), scope: { ...scope }, estimate: estimateMicros, targets: items });
      return { ok: true, reservation };
    }
    return { ok: false, reason: "busy" };
  }
  async settle(reservation: Reservation, actualMicros: number): Promise<void> {
    const open = this.#open.get(reservation.id);
    if (open === undefined) return; // Already closed; never count the same call twice.
    if (!whole(actualMicros)) throw new Error("settlement unavailable");
    // Validate the whole transaction before writes. An arithmetic failure keeps every hold.
    for (const t of open.targets) if (!Number.isSafeInteger(this.#row(t, open.scope).committed - open.estimate + actualMicros)) throw new Error("settlement unavailable");
    for (const target of open.targets) {
      const row = this.#row(target, open.scope);
      const spentMicros = row.spentMicros + actualMicros;
      this.#rows.set(target.key, { ...row, spentMicros, reservedMicros: row.reservedMicros - open.estimate, committed: row.committed - open.estimate + actualMicros, overrun: row.overrun || (target.cap !== undefined && spentMicros > target.cap) });
    }
    this.#open.delete(reservation.id);
    const companyKey = JSON.stringify([open.scope.iss, open.scope.cid]);
    // A late settlement cannot release a newer call's marker.
    if (this.#inFlight.get(companyKey)?.owner === reservation.id) this.#inFlight.delete(companyKey);
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
  return ["one overrun in flight", "marker expiry keeps hold", "atomic hold", "cap subtraction", "no partial write", "overrun settle", "closed settle", "company ceiling", "isolation", "optional person"];
}
