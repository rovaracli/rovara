// Convergence lane A5: Cloud's `Admission` on Rovara Code's port (packages/contracts ports/policy.ts), over Code's `DocumentStore` (in Cloud, lane A1's
// DynamoDB store on the State table). Nothing calls it yet: the composition root (S0) registers it. Owner decision 79: it declares `enforcesCost: true`.
//
// What it holds on: Cloud's own spend counters, `ORG#<org>#SPEND#<month>` / `<scopeKey>` (`spendCounterKey`), the same rows and the same dollar units the
// key ledger (`spend/ledger.ts#reserve`) holds a key's cap on. A hold adds to `committedUsd` under the same condition a key's reservation does
// (`committedUsd <= limit - amount`, a millionth of slack for float dust), so a hold and a key race for one room and neither can overspend it.
//
// The money rules, each tested (tests/unit/cloud-money-admission.test.ts):
//   - A hold is one marker row per admission key (`ADMISSION_HOLD#<sha256(company, key)>`), written with `attribute_not_exists` in the same transaction as
//     the counters: asking twice with one key, or retrying a lost answer, holds once and answers the same reservation.
//   - Concurrent holds race on the counters' conditions (an atomic ADD under a condition, never read-modify-write): the room cannot be overspent.
//   - `settle` and `release` change the counters only in a transaction conditional on the hold still being `held`, so each happens at most once, and only one
//     of the two.
//   - An unknown cost is never $0 (decision 79): a request with no estimate (or an estimate of $0, or not in dollars) holds the action's worst case; a
//     settle that names no dollar cost charges the whole hold, as the 0.5.13 model proxy ledger charges a reservation whose usage never came back.
//   - A hold that outlives its time (its caller died before it could settle or release) is charged in full by `sweepExpiredHolds`, never given back unseen.
//   - Every key is under the request's own company (`ORG#<company>#`); a reservation id names its company and a hold row is checked against it, so one
//     company's admissions never touch another's counters.
import { createHash } from "node:crypto";
import { change, OrgIdSchema, orgScoped, queryAll, when, type Admission, type AdmissionDecision, type AdmissionRequest, type Condition, type DocumentKey, type DocumentStore, type StoredDocument, type TransactItem } from "@rovara-code/contracts";
import { spendCounterKey, type BudgetScope } from "@agentx/cloud-contracts";
import { cleanUsd } from "../../spend/top-ups.js";
import { isCountableCost, microsToUsd } from "./units.js";

/** One budget a request counts against, as Cloud's settings say for the month: the scope's `scopeKey`, its kind (for the refusal's code), and its limit in dollars (undefined: none). */
export interface AdmissionLevel {
  scope: string;
  kind: BudgetScope["kind"];
  limitUsd: number | undefined;
}

/**
 * How an action is admitted.
 *  - `room`: allowed while every limited scope has at least `minimumUsd` left (Cloud's `admitWork` minimum for the path); holds nothing, so no reservation.
 *    Staged as `check` steps, so the caller's transaction commits only while the room is still there.
 *  - `hold`: holds the request's dollar estimate on every scope (refused when a limited scope has less left), or `unknownCostUsd` when the request names no
 *    usable estimate.
 */
export type CloudActionRule = { kind: "room"; minimumUsd: number } | { kind: "hold"; unknownCostUsd: number };

/**
 * What a refusal knows, for the words it is told in. `message` is this adapter's own sentence (a neutral one); a host that has words of its own for the
 * same refusal (Cloud's: convergence S0-143d) returns them from `CloudAdmissionOptions.words`. The figures are in dollars; `spentUsd` is what the counter says
 * is spent, `committedUsd` what is spent or held by running work.
 */
export interface RefusalCircumstance {
  code: string;
  message: string;
  /** The budget scope that was short (a money refusal only). */
  kind?: BudgetScope["kind"];
  limitUsd?: number;
  spentUsd?: number;
  committedUsd?: number;
  projectName?: string;
}

export interface CloudAdmissionOptions {
  store: DocumentStore;
  /** The sentence a refusal is told in. Absent: this adapter's own. A host's words for a code must be a person-fit sentence and never raw text (the core shows `message` as it is). */
  words?: (circumstance: RefusalCircumstance) => string;
  /** Epoch milliseconds. */
  now?: () => number;
  /** The scopes and limits of a request in a month (Cloud: `budgetScopesFor` and `effectiveLimits`). A failure is a fault and propagates; nothing is written. */
  levels(request: AdmissionRequest, month: string): Promise<readonly AdmissionLevel[]>;
  /** Refusals that come before money (Cloud: the trial lock, the month's machine time). Undefined: no refusal. */
  gate?(request: AdmissionRequest): Promise<{ code: string; message: string } | undefined>;
  /** Each action this install admits. An action not listed is refused (fail closed): a new spending action is a wiring decision, never a free pass. */
  actions: Readonly<Record<string, CloudActionRule>>;
  /** How long a hold may stay open before the sweep charges it. Default one hour. */
  holdTtlSeconds?: number;
  /**
   * One writer per model spend (DEFERRED A5-S0-OPEN-QUESTIONS point 2). A model call that runs on a LiteLLM key is already counted on the same `SPEND#`
   * counters by the key ledger's settlement (`spend/ledger.ts`, R22). For a request this answers true for, the hold still guards the room, but it is only
   * ever RELEASED: `settle` gives the hold back and counts nothing, and the expired-hold sweep gives it back too (the ledger charges its own orphaned
   * reservation). Absent: no request is counted elsewhere, and every hold settles as before.
   */
  countedByKeyLedger?(request: AdmissionRequest): boolean;
}

const HOLD_ENTITY = "ADMISSION_HOLD";
const OPEN_ENTITY = "ADMISSION_HOLD_OPEN";
const COUNTER_ENTITY = "SPEND_COUNTER";
const DEFAULT_TTL_SECONDS = 3_600;
/** How often `admit` decides again after a condition refused its write. */
const ADMIT_TRIES = 3;
/** The slack `ledger.ts#reserve` gives a condition, so float dust never refuses a hold that fits exactly. */
const SLACK_USD = 0.000001;
const RESERVATION = /^(org_[0-9a-z]{20})\.([0-9a-f]{64})$/;

/** The refusal code of each kind of scope, as the core's task flow reads them (core/task-flow/admission.ts REFUSAL_CODES) where it knows them. */
const SCOPE_CODES: Record<BudgetScope["kind"], string> = {
  org: "org_budget_exceeded",
  member: "budget_exceeded",
  project: "project_budget_exceeded",
  agent: "agent_budget_exceeded",
  chain: "chain_budget_exceeded",
  testing: "test_allowance_used",
};

const SCOPE_WORDS: Record<BudgetScope["kind"], string> = {
  org: "Your company's monthly AI budget",
  member: "Your monthly AI budget",
  project: "This project's monthly AI budget",
  agent: "This agent's monthly AI budget",
  chain: "This chain's budget",
  testing: "Your testing allowance for this month",
};

type HoldState = "held" | "settled" | "released";

interface HoldRow {
  orgId: string;
  holdId: string;
  action: string;
  month: string;
  heldUsd: number;
  scopes: string[];
  state: HoldState;
  openSk: string;
  expiresAt: number;
  /** Set when the key ledger counts this hold's spend: the hold is released, never settled (`CloudAdmissionOptions.countedByKeyLedger`). */
  countedBy?: "key-ledger";
}

export const monthOfMs = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 7);

const holdIdOf = (companyId: string, idempotencyKey: string): string => createHash("sha256").update(`${companyId}\u0000${idempotencyKey}`).digest("hex");
export const holdKey = (companyId: string, holdId: string): DocumentKey => ({ pk: orgScoped(companyId, `ADMISSION_HOLD#${holdId}`), sk: "HOLD" });
export const openHoldsPk = (companyId: string): string => orgScoped(companyId, "ADMISSION_HOLDS_OPEN");
const reservationIdOf = (companyId: string, holdId: string): string => `${companyId}.${holdId}`;

const refusedAs = (words: CloudAdmissionOptions["words"], circumstance: RefusalCircumstance): Extract<AdmissionDecision, { allowed: false }> => ({ allowed: false, code: circumstance.code, message: words?.(circumstance) ?? circumstance.message });

function readHold(item: StoredDocument | undefined, companyId: string, holdId: string): HoldRow | undefined {
  if (item === undefined || item["entityType"] !== HOLD_ENTITY || item["orgId"] !== companyId || item["holdId"] !== holdId) return undefined;
  const state = item["state"], heldUsd = item["heldUsd"], month = item["month"], scopes = item["scopes"], openSk = item["openSk"], expiresAt = item["expiresAt"];
  if ((state !== "held" && state !== "settled" && state !== "released") || typeof heldUsd !== "number" || !(heldUsd >= 0) || typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)
    || !Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string") || typeof openSk !== "string" || typeof expiresAt !== "number") return undefined;
  return { orgId: companyId, holdId, action: typeof item["action"] === "string" ? item["action"] : "", month, heldUsd, scopes: scopes, state, openSk, expiresAt, ...(item["countedBy"] === "key-ledger" ? { countedBy: "key-ledger" as const } : {}) };
}

const counterNumber = (item: StoredDocument | undefined, name: string): number => {
  const value = item?.[name];
  return typeof value === "number" && Number.isFinite(value) ? cleanUsd(value) : 0;
};

/** The condition that a limited counter still has `amountUsd` of room: the key ledger's own (`reserve`). */
const roomFor = (limitUsd: number, amountUsd: number): Condition =>
  when.or(when.notExists("committedUsd"), when.lte("committedUsd", cleanUsd(limitUsd - amountUsd + SLACK_USD)));

/** Cloud's Admission adapter. */
export class CloudAdmission implements Admission {
  /** Decision 79: this adapter refuses a request whose dollar cost does not fit the room left. */
  readonly enforcesCost = true;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly options: CloudAdmissionOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = (options.holdTtlSeconds ?? DEFAULT_TTL_SECONDS) * 1_000;
    if (!(this.ttlMs > 0)) throw new RangeError("a hold must have a positive lifetime");
    for (const [action, rule] of Object.entries(options.actions)) {
      if (rule.kind === "hold" && !(Number.isFinite(rule.unknownCostUsd) && rule.unknownCostUsd > 0)) throw new RangeError(`the action ${action} must hold more than $0 when its cost is unknown (decision 79)`);
      if (rule.kind === "room" && !(Number.isFinite(rule.minimumUsd) && rule.minimumUsd >= 0)) throw new RangeError(`the action ${action} needs a minimum room of $0 or more`);
    }
  }

  async admit(request: AdmissionRequest): Promise<AdmissionDecision> {
    for (let attempt = 0; attempt < ADMIT_TRIES; attempt += 1) {
      const staged = await this.prepare(request);
      if (!staged.decision.allowed || staged.items.length === 0) return staged.decision;
      if ((await this.options.store.transact(staged.items)).applied) return staged.decision;
      // Refused by a condition: the hold row was there (an earlier call with this key won; the next read answers its reservation), or another hold or key
      // took the room between the read and the write (the next read decides again from the counters as they are now).
    }
    return { ...this.refuse(request, { code: "budget_busy", message: "Other work is taking this budget's room right now. Try again in a moment." }), retryAfterSeconds: 1 };
  }

  async stage(request: AdmissionRequest): Promise<{ decision: AdmissionDecision; items: readonly TransactItem[] }> {
    const { decision, items } = await this.prepare(request);
    return { decision, items };
  }

  async settle(reservationId: string, actual: { tokens?: number; cost?: { micros: number; currency: string } }): Promise<void> {
    const hold = await this.openHold(reservationId);
    if (hold === undefined) return;
    // The key ledger counts this spend (one writer per spend): give the hold back and count nothing here.
    if (hold.countedBy === "key-ledger") { await this.close(hold, "released", 0); return; }
    // A cost Cloud cannot count (none, or not in dollars) charges the whole hold: an unknown cost is never $0 (decision 79).
    const actualUsd = isCountableCost(actual.cost) ? microsToUsd(actual.cost.micros) : hold.heldUsd;
    await this.close(hold, "settled", actualUsd);
  }

  async release(reservationId: string): Promise<void> {
    const hold = await this.openHold(reservationId);
    if (hold === undefined) return;
    await this.close(hold, "released", 0);
  }

  /**
   * Charges in full every hold of a company whose time has passed (its caller died before it settled or released it): the work may have spent, so the
   * hold counts as spent, as the model proxy's ledger charges an orphaned reservation. Answers how many it charged. Safe to run at any time, and twice.
   */
  async sweepExpiredHolds(companyId: string): Promise<number> {
    if (!OrgIdSchema.safeParse(companyId).success) return 0;
    const due = await queryAll(this.options.store, { pk: openHoldsPk(companyId), sk: { op: "lt", value: `${new Date(this.now()).toISOString()}~` } });
    let charged = 0;
    for (const row of due) {
      const holdId = row["holdId"];
      if (typeof holdId !== "string") continue;
      const hold = readHold(await this.options.store.get(holdKey(companyId, holdId)), companyId, holdId);
      if (hold === undefined || hold.state !== "held" || hold.expiresAt > this.now()) continue;
      // A hold the key ledger counts is given back: the ledger charges its own orphaned reservation, and charging here too would count the spend twice.
      if (hold.countedBy === "key-ledger" ? await this.close(hold, "released", 0) : await this.close(hold, "settled", hold.heldUsd)) charged += 1;
    }
    return charged;
  }

  // ---- inside ----

  private async openHold(reservationId: string): Promise<HoldRow | undefined> {
    const match = RESERVATION.exec(reservationId);
    if (match === null) return undefined;
    const [, companyId, holdId] = match as unknown as [string, string, string];
    const hold = readHold(await this.options.store.get(holdKey(companyId, holdId)), companyId, holdId);
    return hold?.state === "held" ? hold : undefined;
  }

  /**
   * Ends a hold once: the hold row moves from `held` to `state` (the condition), its open-hold row goes, and the counters of the hold's own company and month
   * give back the hold and count `spentUsd`. False when the hold was no longer held (another call ended it first): nothing changed.
   */
  private async close(hold: HoldRow, state: Exclude<HoldState, "held">, spentUsd: number): Promise<boolean> {
    const spent = cleanUsd(spentUsd);
    const committedDelta = cleanUsd(spent - hold.heldUsd);
    const items: TransactItem[] = [
      { kind: "update", key: holdKey(hold.orgId, hold.holdId), ops: [change.set("state", state), change.set("spentUsd", spent), change.set("closedAt", new Date(this.now()).toISOString())], condition: when.and(when.present(), when.eq("state", "held")) },
      { kind: "delete", key: { pk: openHoldsPk(hold.orgId), sk: hold.openSk } },
      ...hold.scopes.flatMap((scope): TransactItem[] => {
        const ops = [...(committedDelta === 0 ? [] : [change.add("committedUsd", committedDelta)]), ...(spent === 0 ? [] : [change.add("spentUsd", spent)])];
        return ops.length === 0 ? [] : [{ kind: "update", key: spendCounterKey(hold.orgId, hold.month, scope), ops: [...ops, change.setIfAbsent("entityType", COUNTER_ENTITY)] }];
      }),
    ];
    return (await this.options.store.transact(items)).applied;
  }

  /** A refusal, in the host's words when it gave some. */
  private refuse(request: AdmissionRequest, circumstance: RefusalCircumstance): Extract<AdmissionDecision, { allowed: false }> {
    return refusedAs(this.options.words, { ...circumstance, ...(request.projectName === undefined ? {} : { projectName: request.projectName }) });
  }

  /** The decision and the steps for a request, from the counters as they are now. A refusal has no steps. */
  private async prepare(request: AdmissionRequest): Promise<{ decision: AdmissionDecision; items: TransactItem[]; holdId?: string }> {
    if (!OrgIdSchema.safeParse(request.companyId).success) return { decision: this.refuse(request, { code: "admission_invalid_request", message: "This request names no company Rovara knows." }), items: [] };
    if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.length === 0 || request.idempotencyKey.length > 512) return { decision: this.refuse(request, { code: "admission_invalid_request", message: "This request has no usable key." }), items: [] };
    const rule = Object.hasOwn(this.options.actions, request.action) ? this.options.actions[request.action] : undefined;
    if (rule === undefined) return { decision: this.refuse(request, { code: "admission_action_unknown", message: "Rovara does not admit this kind of work on this install." }), items: [] };
    const estimate = request.estimate?.cost;
    if (estimate !== undefined && estimate.currency !== "USD") return { decision: this.refuse(request, { code: "currency_unsupported", message: "Rovara counts spend in US dollars only." }), items: [] };
    // A known dollar estimate above $0, or the action's worst case: never $0 (decision 79).
    const amountUsd = cleanUsd(rule.kind === "room" ? rule.minimumUsd
      : isCountableCost(estimate) && estimate.micros > 0 ? microsToUsd(estimate.micros) : rule.unknownCostUsd);
    const holdId = rule.kind === "hold" ? holdIdOf(request.companyId, request.idempotencyKey) : undefined;
    if (holdId !== undefined) {
      const existing = readHold(await this.options.store.get(holdKey(request.companyId, holdId)), request.companyId, holdId);
      if (existing !== undefined) {
        // The same request again answers the same reservation and holds nothing more, but only while that hold is still held and is this request: a key
        // whose hold was settled or released, or reused for another action or amount, is refused rather than answered with a reservation that holds nothing.
        if (existing.state === "held" && existing.action === request.action && existing.heldUsd === amountUsd) return { decision: { allowed: true, reservationId: reservationIdOf(request.companyId, holdId) }, items: [], holdId };
        return { decision: this.refuse(request, { code: "admission_key_reused", message: "This request's key was already used for other or finished work. Ask again with a new key." }), items: [], holdId };
      }
    }
    const gate = await this.options.gate?.(request);
    if (gate !== undefined) return { decision: this.refuse(request, { code: gate.code, message: gate.message }), items: [] };
    const now = this.now();
    const month = monthOfMs(now);
    const levels = dedupe(await this.options.levels(request, month));
    const counters = await this.options.store.getMany(levels.map((level) => spendCounterKey(request.companyId as never, month, level.scope)));
    for (const [index, level] of inRefusalOrder(levels)) {
      if (level.limitUsd === undefined) continue;
      const committed = counterNumber(counters[index], "committedUsd");
      const short = rule.kind === "room" ? cleanUsd(level.limitUsd - committed) < amountUsd : committed > cleanUsd(level.limitUsd - amountUsd + SLACK_USD) || cleanUsd(level.limitUsd - amountUsd) < 0;
      if (short) {
        return {
          decision: this.refuse(request, {
            code: SCOPE_CODES[level.kind],
            message: `${SCOPE_WORDS[level.kind]} has too little left for this ($${cleanUsd(Math.max(0, level.limitUsd - committed)).toFixed(2)} of $${level.limitUsd.toFixed(2)} left). Try again when running work finishes, or ask an admin to raise it.`,
            kind: level.kind, limitUsd: level.limitUsd, committedUsd: committed, spentUsd: counterNumber(counters[index], "spentUsd"),
          }),
          items: [], ...(holdId === undefined ? {} : { holdId }),
        };
      }
    }
    if (rule.kind === "room") {
      const checks = levels.flatMap((level): TransactItem[] => level.limitUsd === undefined ? []
        : [{ kind: "check", key: spendCounterKey(request.companyId as never, month, level.scope), condition: when.or(when.notExists("committedUsd"), when.lte("committedUsd", cleanUsd(level.limitUsd - amountUsd))) }]);
      return { decision: { allowed: true }, items: checks };
    }
    const id = holdId!;
    const expiresAt = now + this.ttlMs;
    const openSk = `${new Date(expiresAt).toISOString()}#${id}`;
    const items: TransactItem[] = [
      { kind: "put", item: { ...holdKey(request.companyId, id), entityType: HOLD_ENTITY, orgId: request.companyId, holdId: id, action: request.action, month, heldUsd: cleanUsd(amountUsd), scopes: levels.map((level) => level.scope), state: "held", openSk, expiresAt, ...(this.options.countedByKeyLedger?.(request) === true ? { countedBy: "key-ledger" } : {}), createdAt: new Date(now).toISOString() }, condition: when.absent() },
      { kind: "put", item: { pk: openHoldsPk(request.companyId), sk: openSk, entityType: OPEN_ENTITY, orgId: request.companyId, holdId: id }, condition: when.absent() },
      ...levels.map((level): TransactItem => ({
        kind: "update", key: spendCounterKey(request.companyId as never, month, level.scope),
        ops: [change.add("committedUsd", cleanUsd(amountUsd)), change.setIfAbsent("entityType", COUNTER_ENTITY)],
        ...(level.limitUsd === undefined ? {} : { condition: roomFor(level.limitUsd, amountUsd) }),
      })),
    ];
    return { decision: { allowed: true, reservationId: reservationIdOf(request.companyId, id) }, items, holdId: id };
  }
}

/** One level per scope (the first wins), so a transaction never names one counter twice. */
function dedupe(levels: readonly AdmissionLevel[]): AdmissionLevel[] {
  const seen = new Set<string>();
  return levels.filter((level) => !seen.has(level.scope) && seen.add(level.scope));
}

/** The order refusals are told in (Cloud's `admission.ts` REFUSAL_ORDER): the member's own budget first, then the company's, then the rest. With each level's index. */
const ORDER: Record<BudgetScope["kind"], number> = { member: 0, org: 1, project: 2, testing: 3, agent: 4, chain: 4 };
const inRefusalOrder = (levels: readonly AdmissionLevel[]): Array<[number, AdmissionLevel]> =>
  levels.map((level, index): [number, AdmissionLevel] => [index, level]).sort((a, b) => ORDER[a[1].kind] - ORDER[b[1].kind]);

export function createCloudAdmission(options: CloudAdmissionOptions): CloudAdmission {
  return new CloudAdmission(options);
}
