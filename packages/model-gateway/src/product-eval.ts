// The product route's whole-stage eval hold (Code #683 EvalModelAccess; DEC 165, 203, 228c). Code's final-check eval holds the
// WHOLE estimate of a stage before its first call, runs the stage's calls under that one hold, and releases it once:
//
//   POST /v1/product/eval/hold     {grant, calls, costMicros}                 -> {scope, calls, costMicros, expiresAt}
//   POST /v1/product/gemini/...    (x-rovara-eval-scope: <scope>)             -> an event stream: one head, chunks, one settle
//   POST /v1/product/eval/release  {scope, calls, costMicros, unknown}        -> {released}
//
// All three carry the same TC-1 task token. The hold is ONE meter reservation of the whole cost against the product rows and the
// combined company row (company room, project month room), checked against the approved project eval budget and the grant,
// after re-reading the approval, the approver's current role and the product-key connection. A refusal holds nothing. The scope
// is opaque, bound to install, company, project and task: any other caller's lookup is the same "not found" as a missing one.
// Each call under the scope reserves nothing new on the meter; it is admitted against the stage's own count and spend.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { validCaps, type Caps, type CapsSource } from "./caps.js";
import type { EstimatedSettlement, Meter, MeterItem, MeterScope, Reservation, ReserveInput, ReserveResult } from "./meter.js";
import { record, TASK_TOKEN_SECONDS, whole, type TaskClaims } from "./model-gateway-token.js";
import { CALL_HARD_CEILING_MS } from "./provider.js";
import type { GatewaySink, ProductControl, RouteRefusal } from "./server.js";

/** DEC 203: an approved project eval budget of about 400 calls and $4, per stage run; configurable per project. */
export const EVAL_DEFAULT_BUDGET = Object.freeze({ calls: 400, costMicros: 4_000_000 });
/** How long a stage may stay open. After it, the stage refuses calls and is released at its counted spend (whole hold if a call is open). */
export const EVAL_STAGE_MS = 4 * 60 * 60_000;
/** The longest a call waits for its turn when it may pass the held cost (it then runs alone). */
export const EVAL_STAGE_WAIT_MS = 120_000;
export const EVAL_OPEN_STAGES_PER_COMPANY = 8;
export const EVAL_OPEN_STAGES_MAX = 2_000;
/** Stages kept in memory at most (settled ones are dropped first). */
export const EVAL_STAGES_KEPT_MAX = 10_000;
export const EVAL_SCOPE_HEADER = "x-rovara-eval-scope";
export const EVAL_HOLD_PATH = "/v1/product/eval/hold";
export const EVAL_RELEASE_PATH = "/v1/product/eval/release";
export const EVAL_HOLD_REFUSED = "the eval budget could not be held";
export const EVAL_STAGE_SPENT = "the eval stage's held budget is used up";
export const EVAL_ALREADY_RELEASED = "the eval hold was already released";
export const EVAL_CLASSES = ["ok", "rate_limit", "quota", "overloaded", "cap", "key_refused", "provider_error", "refused"] as const;
export type EvalCallClass = typeof EVAL_CLASSES[number];
export type EvalRole = "owner" | "admin" | "maintainer";
const ROLES: readonly string[] = ["owner", "admin", "maintainer"];

/** Code's EvalSpendGrant, as sent: validated field by field at runtime. */
export interface EvalGrant {
  company: string; project: string; selection: string; role: EvalRole; inputsDigest: string;
  provider: "customer"; connected: boolean; maxCalls: number; maxCostMicros: number;
}
/** The persisted, approved eval spend for a project (Code's EVAL_SPEND_APPROVAL), as the gateway re-reads it at hold time. */
export interface EvalApproval {
  selection: string; inputsDigest: string; maxCalls: number; maxCostMicros: number;
  /** When set, every call of a stage must name this model. */
  model?: string;
  approver: { personId: string; provider: string };
}
export interface EvalApprovalSource {
  /** The project's current approved eval spend; undefined when none, rejected or revoked. A failed read throws (503, nothing held). */
  current(iss: string, cid: string, project: string, signal?: AbortSignal): Promise<EvalApproval | undefined>;
  /** The approver's CURRENT role in that project (membership re-read, never cached); undefined when no longer a member. */
  roleOf(iss: string, cid: string, project: string, approver: EvalApproval["approver"], signal?: AbortSignal): Promise<EvalRole | undefined>;
}
export interface ProductEvalOptions {
  approvals: EvalApprovalSource;
  /** The approved project eval budget; default EVAL_DEFAULT_BUDGET. */
  budget?: (iss: string, cid: string, project: string) => Promise<{ calls: number; costMicros: number }>;
  now?: () => number;
  stageMs?: number;
  waitMs?: number;
}
/** What the hold needs from the product route (createProductRoutes supplies it). */
export interface ProductEvalContext {
  meter: Meter;
  caps: CapsSource;
  connected(claims: TaskClaims, signal: AbortSignal): Promise<boolean>;
  blocked(claims: TaskClaims): Promise<boolean>;
  block(claims: TaskClaims): Promise<void>;
}

/** `marker`: the company's one overrun-capable-call-in-flight marker, taken on the real meter by a call that may pass the hold. */
interface SubCall { estimate: number; exclusive: boolean; marker?: Reservation }
export interface EvalStage {
  readonly id: string; readonly iss: string; readonly cid: string; readonly pid: string; readonly tid: string;
  readonly heldCalls: number; readonly heldCost: number; readonly deadline: number; readonly model?: string;
  readonly reservation: Reservation; readonly claims: TaskClaims; readonly meterScope: MeterScope;
  /** open: takes calls. stopped: takes none (its hold was passed, it was released, or it expired). */
  status: "open" | "stopped";
  /** The caller's one release was accepted. */
  callerReleased: boolean;
  /** The parent hold on the real meter: settled exactly once, only when no call of the stage is open. */
  parent: "held" | "settling" | "settled";
  settledMicros: number;
  /** Settle the parent at no less than the whole hold (the caller said unknown, or it closed with a call open). */
  keepWhole: boolean;
  /** A caller's report, up to the hold: the parent never settles below it. */
  reportedFloor: number;
  /** Company markers kept by a call that passed the hold, given back only after the parent (and so the overshoot) is settled. */
  heldMarkers: Reservation[];
  dispatched: number; spent: number; inFlight: number; inFlightCost: number; exclusive: boolean; estimatedAny: boolean;
  /** Admitted calls still waiting for the company marker: counted open, but nothing has been sent for them yet. */
  claiming: number;
  /** Calls waiting for their turn to run alone: while any wait, no call joins (first come, first served). */
  waitingAlone: number;
  readonly subs: Map<string, SubCall>;
  waiters: Array<() => void>;
}
export interface StageSettle { costMicros: number; estimated: boolean; overrun: boolean }

const refusal = (status: number, code: string, message: string): { status: number; body: Record<string, unknown> } => ({ status, body: { error: { type: code, message } } });
const HOLD_REFUSED = refusal(422, "eval_hold_refused", EVAL_HOLD_REFUSED);
const UNAVAILABLE = refusal(503, "unavailable", "model access unavailable");
const NOT_FOUND = refusal(404, "not_found", "not found");
const SCOPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SELECTION_MAX = 512;
const positive = (v: unknown): v is number => whole(v) && v >= 1;
/** A read bounded by the request's signal (its deadline or disconnect): an abort is a failed read (503, nothing held). */
function raced<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(new Error("aborted")); }
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => { void operation.catch(() => undefined); reject(new Error("aborted")); };
    signal.addEventListener("abort", stop, { once: true });
    operation.then((value) => { signal.removeEventListener("abort", stop); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", stop); reject(error instanceof Error ? error : new Error("read failed")); });
  });
}
const exactKeys = (r: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(r).length === keys.length && keys.every((k) => Object.hasOwn(r, k));

/** Runtime check of Code's grant: every field, no other key. */
export function readGrant(value: unknown): EvalGrant | undefined {
  const g = record(value);
  if (g === undefined || !exactKeys(g, ["company", "project", "selection", "role", "inputsDigest", "provider", "connected", "maxCalls", "maxCostMicros"])) return undefined;
  if (typeof g.company !== "string" || typeof g.project !== "string" || typeof g.selection !== "string" || g.selection.length === 0 || g.selection.length > SELECTION_MAX) return undefined;
  if (typeof g.role !== "string" || !ROLES.includes(g.role) || typeof g.inputsDigest !== "string" || !DIGEST.test(g.inputsDigest)) return undefined;
  if (g.provider !== "customer" || g.connected !== true || !positive(g.maxCalls) || !positive(g.maxCostMicros)) return undefined;
  return g as unknown as EvalGrant;
}
function validApproval(a: unknown): a is EvalApproval {
  const r = record(a); const approver = record(r?.approver);
  return r !== undefined && approver !== undefined && typeof r.selection === "string" && typeof r.inputsDigest === "string" && positive(r.maxCalls) && positive(r.maxCostMicros)
    && (r.model === undefined || typeof r.model === "string") && typeof approver.personId === "string" && typeof approver.provider === "string";
}

/**
 * The stages one gateway process holds. A stage lives in the process that held it (the deployed gateway pins a task's calls to
 * one process; a call or release reaching another process is "not found" and the parent hold is released by expiry and the
 * meter's open-hold sweep, at its whole estimate, never below). PRODUCT-EVAL-STAGE-STORE (DEFERRED): a shared stage table.
 */
export class ProductEvalStages {
  readonly #stages = new Map<string, EvalStage>();
  readonly #pendingHolds = new Map<string, number>();
  readonly #options: ProductEvalOptions;
  readonly #now: () => number;
  readonly #stageMs: number;
  readonly #waitMs: number;
  #context: ProductEvalContext | undefined;
  constructor(options: ProductEvalOptions) {
    this.#options = options; this.#now = options.now ?? Date.now;
    this.#stageMs = positive(options.stageMs) ? Math.min(options.stageMs, 24 * 60 * 60_000) : EVAL_STAGE_MS;
    this.#waitMs = positive(options.waitMs) ? options.waitMs : EVAL_STAGE_WAIT_MS;
  }
  /** Set once by createProductRoutes. */
  bind(context: ProductEvalContext): void { if (this.#context !== undefined) throw new Error("eval stages already bound"); this.#context = context; }
  #key(iss: string, cid: string, id: string): string { return JSON.stringify([iss, cid, id]); }
  /** The stage for this caller, or undefined: missing, another company's, another project's and another task's are one answer. */
  find(claims: TaskClaims, id: string | undefined): EvalStage | undefined {
    if (typeof id !== "string" || !SCOPE.test(id)) return undefined;
    const stage = this.#stages.get(this.#key(claims.iss, claims.cid, id));
    return stage !== undefined && stage.pid === claims.pid && stage.tid === claims.tid ? stage : undefined;
  }

  control(path: string): ProductControl | undefined {
    if (path === EVAL_HOLD_PATH) return { control: true, handle: (claims, body, signal) => this.hold(claims, body, signal) };
    // A release only gives budget back: it is taken after the task ended too.
    if (path === EVAL_RELEASE_PATH) return { control: true, afterTaskEnd: true, handle: (claims, body) => this.release(claims, body) };
    return undefined;
  }

  async hold(claims: TaskClaims, body: unknown, signal: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
    const context = this.#context; if (context === undefined) return UNAVAILABLE;
    // The open-stage limits count a slot for this hold at once (no await between the check and the count).
    if (this.#holding(claims) >= EVAL_OPEN_STAGES_PER_COMPANY || this.#holding() >= EVAL_OPEN_STAGES_MAX) return refusal(429, "busy", "too many eval stages are open; try again later");
    const slot = JSON.stringify([claims.iss, claims.cid]);
    this.#pendingHolds.set(slot, (this.#pendingHolds.get(slot) ?? 0) + 1);
    try { return await this.#hold(context, claims, body, signal); }
    finally { const left = (this.#pendingHolds.get(slot) ?? 1) - 1; if (left > 0) this.#pendingHolds.set(slot, left); else this.#pendingHolds.delete(slot); }
  }
  async #hold(context: ProductEvalContext, claims: TaskClaims, body: unknown, signal: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
    const input = record(body);
    if (input === undefined || !exactKeys(input, ["grant", "calls", "costMicros"]) || !positive(input.calls) || !positive(input.costMicros)) return HOLD_REFUSED;
    const calls = input.calls; const costMicros = input.costMicros;
    const grant = readGrant(input.grant);
    // The grant must be this token's company and project.
    if (grant === undefined || grant.company !== claims.cid || grant.project !== claims.pid) return HOLD_REFUSED;
    if (calls > grant.maxCalls || costMicros > grant.maxCostMicros) return HOLD_REFUSED;
    let approval: EvalApproval | undefined; let role: EvalRole | undefined; let budget: { calls: number; costMicros: number }; let connected: boolean;
    try {
      if (await raced(context.blocked(claims), signal)) return HOLD_REFUSED;
      approval = await raced(this.#options.approvals.current(claims.iss, claims.cid, claims.pid, signal), signal);
      if (approval === undefined) return HOLD_REFUSED;
      if (!validApproval(approval)) return UNAVAILABLE;
      // The grant must be exactly the approved spend: selection, inputs, and the confirmed ceilings.
      if (approval.selection !== grant.selection || approval.inputsDigest !== grant.inputsDigest || approval.maxCalls !== grant.maxCalls || approval.maxCostMicros !== grant.maxCostMicros) return HOLD_REFUSED;
      // The approver's role NOW, not the role recorded with the grant.
      role = await raced(this.#options.approvals.roleOf(claims.iss, claims.cid, claims.pid, { personId: approval.approver.personId, provider: approval.approver.provider }, signal), signal);
      if (role === undefined || !ROLES.includes(role)) return HOLD_REFUSED;
      budget = await raced((this.#options.budget ?? (async () => EVAL_DEFAULT_BUDGET))(claims.iss, claims.cid, claims.pid), signal);
      if (!positive(budget.calls) || !positive(budget.costMicros)) return UNAVAILABLE;
      if (calls > budget.calls || costMicros > budget.costMicros) return HOLD_REFUSED;
      // The product key connection, re-read now.
      connected = await raced(context.connected(claims, signal), signal);
    } catch { return UNAVAILABLE; }
    if (!connected) return HOLD_REFUSED;

    let caps: Caps;
    try { caps = await raced(context.caps.capsFor({ iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid }, signal), signal); } catch { return UNAVAILABLE; }
    // The reads above are bounded by the request's deadline; the reservation below is not raced (its outcome must be known).
    if (signal.aborted) return UNAVAILABLE;
    if (!validCaps(caps) || caps.companyMonth === undefined || caps.combinedCompanyMonth === undefined) return UNAVAILABLE;
    const id = randomUUID();
    const now = this.#now(); const deadline = now + this.#stageMs;
    // The stage's own task row is the stage itself (its cap is the held cost); the project, product-ceiling and combined company
    // rows are the month's. One conditional reservation: all of them or none.
    const scope: MeterScope = { iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: `eval.${id}` };
    let reserved: ReserveResult;
    try { reserved = await context.meter.reserve({ scope, caps: { ...caps, task: costMicros }, estimateMicros: costMicros, sweepAfter: deadline }); } catch { return UNAVAILABLE; }
    if (!reserved.ok) {
      if (reserved.reason === "busy") return UNAVAILABLE;
      if (reserved.reason === "cap" && reserved.held) return refusal(429, "budget_held", "budget is held by another call");
      return refusal(422, "budget_exceeded", EVAL_HOLD_REFUSED);
    }
    const stage: EvalStage = {
      id, iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid, heldCalls: calls, heldCost: costMicros, deadline,
      ...(approval.model === undefined ? {} : { model: approval.model }), reservation: reserved.reservation, claims, meterScope: scope,
      status: "open", callerReleased: false, parent: "held", settledMicros: 0, keepWhole: false, reportedFloor: 0, heldMarkers: [],
      dispatched: 0, spent: 0, inFlight: 0, inFlightCost: 0, exclusive: false, estimatedAny: false, claiming: 0, waitingAlone: 0, subs: new Map(), waiters: [],
    };
    // Settled stages are kept only to answer a second release; the oldest go first when the table is full.
    if (this.#stages.size >= EVAL_STAGES_KEPT_MAX) for (const [key, old] of this.#stages) { if (this.#stages.size < EVAL_STAGES_KEPT_MAX) break; if (old.parent === "settled" && old.inFlight === 0) this.#stages.delete(key); }
    this.#stages.set(this.#key(claims.iss, claims.cid, id), stage);
    return { status: 200, body: { scope: id, calls, costMicros, expiresAt: deadline } };
  }
  /** Stages still holding money (parent not settled), per company and overall, plus holds being made right now. */
  #holding(claims?: TaskClaims): number {
    let n = 0;
    for (const s of this.#stages.values()) if (s.parent !== "settled" && (claims === undefined || (s.iss === claims.iss && s.cid === claims.cid))) n++;
    for (const [key, count] of this.#pendingHolds) if (claims === undefined || key === JSON.stringify([claims.iss, claims.cid])) n += count;
    return n;
  }

  async release(claims: TaskClaims, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const input = record(body);
    if (input === undefined || !exactKeys(input, ["scope", "calls", "costMicros", "unknown"]) || !whole(input.calls) || !whole(input.costMicros) || typeof input.unknown !== "boolean") return refusal(400, "invalid_request", "request not allowed");
    const stage = this.find(claims, input.scope as string | undefined);
    if (stage === undefined) return NOT_FOUND;
    if (stage.callerReleased) return refusal(409, "already_released", EVAL_ALREADY_RELEASED);
    // The parent is being settled right now (by the last call or the maintenance pass): try again in a moment.
    if (stage.parent === "settling") return UNAVAILABLE;
    stage.callerReleased = true; stage.status = "stopped"; this.#wake(stage);
    // The gateway's own count is the record; a caller's higher report is honoured only up to the hold (never past it on its word).
    stage.reportedFloor = Math.max(stage.reportedFloor, Math.min(input.costMicros, stage.heldCost));
    // Unknown, or a call still open: the whole hold stays spent (more if the stage's one call over took more). The parent is
    // settled when the last open call settles, so that call's real cost is counted too.
    if (input.unknown || stage.inFlight - stage.claiming > 0) stage.keepWhole = true;
    if (stage.parent === "held" && stage.inFlight === 0 && !(await this.#finalize(stage))) {
      // Not settled: the caller may release again (the maintenance pass also retries).
      stage.callerReleased = false;
      return UNAVAILABLE;
    }
    return { status: 200, body: { released: stage.parent === "settled" ? Math.max(0, stage.heldCost - stage.settledMicros) : 0 } };
  }

  /**
   * Settles the parent hold exactly once, and only when no call of the stage is open: at the stage's counted spend, never below
   * the caller's (capped) report, and at least the whole hold when `keepWhole`. Then gives back any company marker kept for the
   * overshoot. A failed settle leaves the parent held for a retry (release again, or the maintenance pass).
   */
  async #finalize(stage: EvalStage): Promise<boolean> {
    if (stage.parent !== "held" || stage.inFlight > 0) return stage.parent === "settled";
    const context = this.#context; if (context === undefined) return false;
    stage.parent = "settling";
    const final = Math.max(stage.spent, stage.reportedFloor, stage.keepWhole ? stage.heldCost : 0);
    const estimated = stage.estimatedAny || stage.keepWhole;
    try {
      await context.meter.settle(stage.reservation, final, estimated && final >= 1 ? { provider: "gemini", model: stage.model ?? "eval-stage", kind: "chat", settledAt: this.#now() } : undefined);
    } catch { stage.parent = "held"; return false; }
    stage.parent = "settled"; stage.settledMicros = final;
    for (const marker of stage.heldMarkers.splice(0)) { try { await context.meter.settle(marker, 0); } catch { /* It expires. */ } }
    return true;
  }

  /**
   * The maintenance pass: an expired stage stops (keeping the whole hold if a call is still open); every stopped stage with no
   * call open whose parent is not settled yet is settled (a retry after a failed settle too); settled stages are forgotten after
   * their deadline.
   */
  async sweep(now: number = this.#now()): Promise<{ released: number; failed: number }> {
    const report = { released: 0, failed: 0 };
    for (const [key, stage] of [...this.#stages]) {
      if (stage.parent === "settled") { if (stage.deadline <= now && stage.inFlight === 0) this.#stages.delete(key); continue; }
      if (stage.deadline <= now && stage.status === "open") { stage.status = "stopped"; if (stage.inFlight - stage.claiming > 0) stage.keepWhole = true; this.#wake(stage); }
      if (stage.status !== "stopped" || stage.inFlight > 0 || stage.parent !== "held") continue;
      if (await this.#finalize(stage)) report.released++; else report.failed++;
    }
    return report;
  }

  /** The per-call meter of one request under a stage: reserves nothing on the real meter. */
  callMeter(stage: EvalStage): Meter & { settled(): StageSettle | undefined } {
    let mine: { id: string } | undefined; let result: StageSettle | undefined;
    const unavailable = async (): Promise<never> => { throw new Error("meter unavailable"); };
    return {
      reserve: async (input: ReserveInput): Promise<ReserveResult> => {
        if (mine !== undefined || record(input) === undefined || !whole(input.estimateMicros)) return { ok: false, reason: "busy" };
        const admitted = await this.#admit(stage, input.estimateMicros, input.overrun);
        if (!admitted.ok) return admitted;
        mine = { id: admitted.reservation.id }; return admitted;
      },
      settle: async (reservation: Reservation, actualMicros: number, estimated?: EstimatedSettlement) => {
        if (mine === undefined || reservation.id !== mine.id) return;
        const sub = stage.subs.get(mine.id); if (sub === undefined) return;
        stage.subs.delete(mine.id);
        const actual = whole(actualMicros) ? actualMicros : sub.estimate;
        stage.inFlight--; stage.inFlightCost -= sub.estimate; stage.spent += actual;
        if (sub.exclusive) stage.exclusive = false;
        const overrun = stage.spent > stage.heldCost;
        if (estimated !== undefined) stage.estimatedAny = true;
        result = { costMicros: actual, estimated: estimated !== undefined, overrun };
        if (sub.marker !== undefined) {
          // A call that passed the hold keeps the company marker until its overshoot is on the meter (the parent settled), so no
          // other call of the company may pass a cap meanwhile (DEC 165, 228c). Otherwise the marker goes with the call.
          if (overrun) stage.heldMarkers.push(sub.marker);
          else { try { await this.#context?.meter.settle(sub.marker, 0); } catch { /* It expires. */ } }
        }
        // DEC 165: the call that passed the held cost is the last; the stage and the task's product calls stop.
        if (overrun && stage.status === "open") { stage.status = "stopped"; void this.#context?.block(stage.claims).catch(() => undefined); }
        this.#wake(stage);
        // The last open call of a stopped stage settles its parent, with every call's real cost counted.
        if (stage.status === "stopped" && stage.inFlight === 0) await this.#finalize(stage);
      },
      settled: () => result,
      pendingKeys: unavailable, pendingFor: unavailable, pendingExpired: unavailable, expire: unavailable, correct: unavailable, read: unavailable,
    };
  }

  /**
   * Admission under the stage: refused once closed, past its deadline, at its held call count, or once its spend reached the held
   * cost. A call that fits (spend + open calls' holds + its own hold within the held cost, and bounded by its price) runs at once;
   * one that may pass the held cost runs only ALONE, so the stage passes its hold by at most that one call (DEC 165).
   */
  async #admit(stage: EvalStage, estimate: number, overrun: ReserveInput["overrun"]): Promise<ReserveResult> {
    const spentUp: ReserveResult = { ok: false, reason: "cap", item: "task", held: false };
    const overrunCapable = overrun !== undefined;
    // Waiting is measured on the process's monotonic clock, not the meter clock.
    const giveUp = performance.now() + this.#waitMs;
    let waitingMyTurn = false; let markerBusy = false;
    try {
    for (;;) {
      if (stage.status !== "open" || this.#now() >= stage.deadline || stage.dispatched >= stage.heldCalls || stage.spent >= stage.heldCost) return spentUp;
      if (!Number.isSafeInteger(stage.spent + stage.inFlightCost + estimate)) return { ok: false, reason: "busy" };
      // A call that may pass the hold runs ALONE: nothing joins it while it is open (or waiting for the company marker), and
      // nothing jumps ahead of one waiting for its turn (REVIEW recheck M1).
      const othersWaiting = stage.waitingAlone - (waitingMyTurn ? 1 : 0);
      const fits = !overrunCapable && !stage.exclusive && othersWaiting === 0 && stage.spent + stage.inFlightCost + estimate <= stage.heldCost;
      const mine = waitingMyTurn;
      if (fits || (stage.inFlight === 0 && (othersWaiting === 0 || mine))) {
        if (mine) { stage.waitingAlone--; waitingMyTurn = false; }
        const id = randomUUID();
        stage.dispatched++; stage.inFlight++; stage.inFlightCost += estimate;
        const sub: SubCall = { estimate, exclusive: !fits };
        stage.subs.set(id, sub);
        if (fits) return { ok: true, reservation: Object.freeze({ id }) };
        stage.exclusive = true;
        // A call that may pass the hold also takes the company's one overrun-capable-call-in-flight marker (DEC 165, 228c):
        // across the agent route, ordinary product calls and every stage, at most one call at a time may pass a cap.
        stage.claiming++;
        let marker: ReserveResult;
        try { marker = await this.#marker(stage, overrun); } finally { stage.claiming--; }
        // Re-checked after the await: the stage may have been released, stopped or expired meanwhile.
        const stillOpen = stage.status === "open" && this.#now() < stage.deadline;
        if (marker.ok && stillOpen) { sub.marker = marker.reservation; return { ok: true, reservation: Object.freeze({ id }) }; }
        if (marker.ok) { try { await this.#context?.meter.settle(marker.reservation, 0); } catch { /* It expires. */ } }
        stage.subs.delete(id); stage.dispatched--; stage.inFlight--; stage.inFlightCost -= estimate; stage.exclusive = false; this.#wake(stage);
        if (!stillOpen || marker.ok) { if ((stage.status as EvalStage["status"]) === "stopped" && stage.inFlight === 0) await this.#finalize(stage); return spentUp; }
        // The company is already past a cap (or the meter refuses): nothing more under this stage.
        if (marker.reason !== "busy") return spentUp;
        if (!marker.overrunInFlight) return { ok: false, reason: "busy" };
        // The company marker is busy elsewhere: retry on the timer only (a wake from this stage would not free it).
        markerBusy = true;
      }
      const fitsAlone = !overrunCapable && stage.spent + stage.inFlightCost + estimate <= stage.heldCost;
      if (!fitsAlone && !waitingMyTurn) { stage.waitingAlone++; waitingMyTurn = true; }
      const left = giveUp - performance.now();
      // Waited for its turn too long: answered like any call behind another company call that may pass a cap (429, retry).
      if (left <= 0) return { ok: false, reason: "busy", overrunInFlight: true };
      const timerOnly = markerBusy; markerBusy = false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(left, 1_000));
        function done(): void { clearTimeout(timer); resolve(); }
        if (!timerOnly) stage.waiters.push(done);
      });
    }
    } finally { if (waitingMyTurn) { stage.waitingAlone--; this.#wake(stage); } }
  }
  /** A zero-cost hold on the real meter carrying the company's in-flight marker; it moves no money. */
  async #marker(stage: EvalStage, overrun: ReserveInput["overrun"]): Promise<ReserveResult> {
    const context = this.#context; if (context === undefined) return { ok: false, reason: "busy" };
    const clock = Math.floor(this.#now() / 1000);
    const open = Number.MAX_SAFE_INTEGER;
    try {
      return await context.meter.reserve({ scope: stage.meterScope, caps: { task: open, projectMonth: open, companyMonth: open, combinedCompanyMonth: open }, estimateMicros: 0,
        overrun: overrun ?? { deadlineSeconds: clock + Math.floor(CALL_HARD_CEILING_MS / 1000), tokenExpiresSeconds: clock + TASK_TOKEN_SECONDS } });
    } catch { return { ok: false, reason: "busy" }; }
  }
  #wake(stage: EvalStage): void { const waiters = stage.waiters; stage.waiters = []; for (const w of waiters) w(); }
}

/** The settle class of one call under a stage, from how the core ended it. */
export function evalClassOf(outcome: { completed: boolean; code?: string }): EvalCallClass {
  if (outcome.completed) return "ok";
  switch (outcome.code) {
    case "budget_exceeded": case "budget_held": case "busy": return "cap";
    case "product_key_refused": return "key_refused";
    case "provider_limited": return "rate_limit";
    case "provider_quota": return "quota";
    case "provider_overloaded": return "overloaded";
    case undefined: case "provider_error": case "provider_refused": return "provider_error";
    default: return "refused";
  }
}
const REFUSAL_WORD: Partial<Record<EvalCallClass, string>> = { cap: "cap", key_refused: "key_refused", rate_limit: "rate_limit", quota: "quota", overloaded: "overloaded" };
const enc = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`);
const WRITE_MS = 10_000;
async function bounded(write: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([write.then(() => true, () => false), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), WRITE_MS); })]); }
  finally { clearTimeout(timer); }
}

/**
 * The answer of one call under a stage, as events (NDJSON, one per line): exactly one head (the call's status and content type),
 * its bytes as chunks (base64), then exactly one settle. The HTTP status is always 200 once the first event is written; a
 * cut-off is a settle that is not ok, never a clean end.
 */
export class EvalEventSink implements GatewaySink {
  #headSent = false; #cut = false; #status = 0; #broken = false;
  constructor(private readonly real: GatewaySink) {}
  #open(): void { if (!this.#headSent) { this.#headSent = true; this.real.head(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" }); } }
  head(status: number, headers: Readonly<Record<string, string>>): void {
    this.#open(); this.#status = status;
    const type = headers["content-type"];
    void this.#write({ kind: "head", status, headers: type === undefined ? [] : [["content-type", type]] });
  }
  #pending: Promise<void> = Promise.resolve();
  #write(event: unknown): Promise<void> {
    this.#pending = this.#pending.then(async () => { if (this.#broken) throw new Error("response unavailable"); if (!(await bounded(this.real.write(enc(event))))) { this.#broken = true; throw new Error("response unavailable"); } });
    return this.#pending;
  }
  async write(bytes: Uint8Array): Promise<void> { await this.#write({ kind: "chunk", b64: Buffer.from(bytes).toString("base64") }); }
  end(): void { /* The settle line ends the stream. */ }
  destroy(): void { this.#cut = true; }
  get cut(): boolean { return this.#cut; }
  /** The one settle line, after the core settled the call. */
  async close(outcome: { completed: boolean; code?: string }, settled: StageSettle | undefined): Promise<void> {
    await this.#pending.catch(() => undefined);
    const cls = this.#cut ? "provider_error" : evalClassOf(outcome);
    if (!this.#headSent) { this.#open(); this.#status = 502; await this.#write({ kind: "head", status: 502, headers: [] }).catch(() => undefined); }
    const word = REFUSAL_WORD[cls];
    const ok = await this.#write({ kind: "settle", status: this.#status, class: cls, ...(word === undefined || cls === "ok" ? {} : { refusal: word }), costMicros: settled?.costMicros ?? 0, estimated: settled?.estimated ?? false, ...(settled?.overrun === true ? { overrun: true } : {}) }).then(() => true, () => false);
    if (ok) this.real.end(); else this.real.destroy();
  }
}
export type { RouteRefusal, MeterItem };
