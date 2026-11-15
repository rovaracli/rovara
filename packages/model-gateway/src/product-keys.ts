// The product key store: the customer's OWN AI key for the calls their tests make (DEC 157), per project, write-only.
// Rovara can use a key (the gateway's product route reads it after the hold) but never shows it: no answer, log, audit row
// or error carries it. Keys are sealed per row (product-seal.ts) and every read names the AWSCURRENT stage (F1-d L3).
//
// Ported rules (PARKED-F1-HANDOFF section 1, F1-d), re-shaped for one table:
// - revisioned documents with fenced operations: request id + keyed fingerprint (F1-d L4), replay-safe;
// - a 7-day recovery window on removal; AWSCURRENT/AWSPREVIOUS promotion on rotation;
// - company sources are LINKED by projects, never copied. There is no dual write, so a removed company source stops
//   answering for every linked project at once (F1-d M1), and nothing can be left half-written (F1-d M2 b): the seal
//   happens before one all-or-nothing transaction, so a failure leaves no state and no pending marker.
import { randomUUID } from "node:crypto";
import { COMPANY, PERSON, PROJECT, record, whole } from "./model-gateway-token.js";
import type { ProductKeyFingerprinter, ProductKeySealer } from "./product-seal.js";
import { parseVertexConnect, serializeVertexCredential, validVertexSummary, vertexSummary, type VertexCredential, type VertexSummary } from "./product-vertex-credential.js";

export const PRODUCT_COMPANY_OWNER = "_company";
/**
 * The company's own learning accounts (DEC 226, learning-keys.ts; PRODUCT-LEARNING-CONNECT-ROUTE): their own document, apart from
 * the company's product sources, so a learning key is never offered to a project, never linked and never resolved for a product
 * call. Company admins only; one source per provider.
 */
export const LEARNING_OWNER = "_learning";
/** The providers a learning account may be (learning-route.ts paths; Vertex learning is not connectable here). */
export const LEARNING_KEY_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type LearningKeyProvider = typeof LEARNING_KEY_PROVIDERS[number];
/** "anthropic" and "openai" are learning accounts only (LEARNING_OWNER); "gemini" is both a product key and a learning account. */
export const PRODUCT_PROVIDERS = ["gemini", "vertex", "anthropic", "openai"] as const;
export type ProductProvider = typeof PRODUCT_PROVIDERS[number];
const LEARNING_ONLY: ReadonlySet<ProductProvider> = new Set(["anthropic", "openai"]);
/**
 * How long a recorded eval approval counts at the stage hold (PRODUCT-EVAL-APPROVER-REREAD): 15 minutes from the role check
 * Cloud made with Code. Older, it is stale and must be approved again.
 */
export const EVAL_APPROVAL_FRESH_MS = 15 * 60_000;
/** People with withdrawn approvals kept by name; past this, every approval made up to now is withdrawn at once (fail closed). */
export const APPROVAL_WITHDRAWALS_MAX = 200;
export const PRODUCT_MAX_SOURCES = 20;
export const PRODUCT_RECOVERY_DAYS = 7;
export const PRODUCT_RECEIPT_SECONDS = 86_400;
const DAY_MS = 86_400_000;
/** DEC 157: Rovara suggests $2 per task at connect time; the company ceiling, when set, caps every project. */
export const PRODUCT_DEFAULT_CAPS: Readonly<ProductCaps> = Object.freeze({ taskMicros: 2_000_000, projectMonthMicros: 50_000_000 });
/** DEC 203: about 400 calls and $4 per eval stage run (product-eval.ts EVAL_DEFAULT_BUDGET repeats it). */
export const PRODUCT_DEFAULT_EVAL_BUDGET: Readonly<EvalBudget> = Object.freeze({ calls: 400, costMicros: 4_000_000 });
export const PRODUCT_SOURCE_ID = /^src_[a-z0-9]{1,32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const CURRENT_STAGE = "AWSCURRENT";

export interface ProductCaps { taskMicros: number; projectMonthMicros: number }
export interface ProductCeiling { taskMicros?: number; projectMonthMicros?: number; companyMonthMicros?: number }
export type ProductRole = "company_admin" | "project_maintainer";
/** The caller (Cloud's settings route) has checked the person's role with Code; the store re-checks what the role may change. */
export interface ProductActor { id: string; role: ProductRole }

export type ProductKeyErrorCode = "invalid" | "stale" | "not_found" | "in_recovery" | "forbidden" | "unavailable" | "too_open" | "refused";
const MESSAGES: Record<ProductKeyErrorCode, string> = {
  invalid: "These product AI settings are not valid.",
  stale: "Product AI settings changed. Refresh and try again.",
  not_found: "Product AI source not found.",
  in_recovery: "This source was removed less than 7 days ago. Recover it, or connect it under a new source id.",
  forbidden: "You can't change these product AI settings.",
  unavailable: "Product AI settings are unavailable right now. Try again.",
  too_open: "This Google setup would trust any Rovara company. Add the attribute condition from the setup steps, then test again.",
  refused: "Google refused these credentials. Check the setup steps, then test again.",
};
/** Fixed words per code. Never echoes input, a key or a cause. */
export class ProductKeyError extends Error { constructor(readonly code: ProductKeyErrorCode) { super(MESSAGES[code]); this.name = "ProductKeyError"; } }

// ---- Table port --------------------------------------------------------------------------------------------------------
export interface StoredRow { version: number; item: Readonly<Record<string, unknown>> }
export type TableCondition = { absent: true } | { version: number } | { exists: true };
/** `check` writes nothing (DynamoDB ConditionCheck): it fences the transaction on another row's version. */
export type TableWrite = { key: string; put: Record<string, unknown>; condition: TableCondition } | { key: string; merge: Record<string, unknown>; condition: { exists: true } } | { key: string; check: { version: number } };
/**
 * One table, all-or-nothing transactions (DynamoDB TransactWriteItems deployed; the adapter is a later lane). Every key starts
 * with `CO#` + JSON [iss, cid], matching the gateway tables' leading-key rule. A sealed-key row is read only with
 * `{ stage: "AWSCURRENT" }` and answers only a row at that stage; a read of a key row without it is DENIED (F1-d L3).
 */
export interface ProductKeyTable {
  get(key: string, read?: { stage: typeof CURRENT_STAGE }): Promise<StoredRow | undefined>;
  /** False when any condition fails; nothing is written then. */
  transact(writes: readonly TableWrite[]): Promise<boolean>;
}
export const isKeyRow = (key: string): boolean => key.includes("#key#");
export class InMemoryProductKeyTable implements ProductKeyTable {
  readonly rows = new Map<string, StoredRow>();
  readonly reads: Array<{ key: string; stage?: string }> = [];
  /** Fault hook: runs before a transaction commits; throw or return false to fail it. */
  constructor(private readonly beforeCommit: (writes: readonly TableWrite[]) => boolean | void = () => undefined) {}
  async get(key: string, read?: { stage: typeof CURRENT_STAGE }): Promise<StoredRow | undefined> {
    this.reads.push({ key, ...(read === undefined ? {} : { stage: read.stage }) });
    const row = this.rows.get(key);
    if (isKeyRow(key)) {
      if (read?.stage !== CURRENT_STAGE) throw new Error("AccessDenied: a key read must name the AWSCURRENT stage");
      return row !== undefined && row.item.stage === CURRENT_STAGE ? structuredClone(row) : undefined;
    }
    return row === undefined ? undefined : structuredClone(row);
  }
  async transact(writes: readonly TableWrite[]): Promise<boolean> {
    if (new Set(writes.map((w) => w.key)).size !== writes.length) return false;
    for (const w of writes) {
      const row = this.rows.get(w.key);
      if ("check" in w) { if ((row?.version ?? 0) !== w.check.version) return false; continue; }
      const c = w.condition;
      if ("absent" in c && row !== undefined) return false;
      if ("version" in c && (row?.version ?? 0) !== c.version) return false;
      if ("exists" in c && row === undefined) return false;
    }
    if (this.beforeCommit(writes) === false) return false;
    for (const w of writes) {
      if ("check" in w) continue;
      const row = this.rows.get(w.key);
      const item = "put" in w ? structuredClone(w.put) : { ...structuredClone(row!.item), ...structuredClone(w.merge) };
      this.rows.set(w.key, { version: (row?.version ?? 0) + 1, item });
    }
    return true;
  }
}

// ---- Documents ---------------------------------------------------------------------------------------------------------
interface SourceRecord {
  sourceId: string; provider: ProductProvider; connectedBy: string; connectedAt: number; updatedAt: number;
  /** Own key: the current version. Absent for a link. */
  currentVersion?: string;
  /** A project's link to a company source (never a copy of its key). */
  link?: string;
  /** The linked company source's connectedAt: a source id re-used after its window is a different source (REVIEW-1 L2). */
  linkedAt?: number;
  warning?: { status: 401 | 403; at: number };
  /** Vertex own key: the non-secret summary (scheme, Google Cloud project, location, service account). */
  vertex?: VertexSummary;
}
interface RemovedRecord { source: SourceRecord; removedAt: number; recoverUntil: number }
/**
 * A project's approved eval spend (Code's EVAL_SPEND_APPROVAL, product-eval.ts EvalApproval), as the settings route records it after
 * checking the approver's role with Code. `role` is that role at approval time; `approvedAt` (when that check began) bounds how
 * long the record counts (EVAL_APPROVAL_FRESH_MS), and a withdrawal of the approver after it ends it (withdrawApprovals).
 */
export interface StoredEvalApproval {
  selection: string; inputsDigest: string; maxCalls: number; maxCostMicros: number; model?: string;
  approver: { personId: string; provider: string }; role: "owner" | "admin" | "maintainer"; approvedAt: number;
}
/** A project's approved eval budget per stage run (DEC 203; default 400 calls and $4). */
export interface EvalBudget { calls: number; costMicros: number }
interface OwnerDoc { sources: SourceRecord[]; removed: RemovedRecord[]; caps?: ProductCaps; ceiling?: ProductCeiling; evalBudget?: EvalBudget; evalApproval?: StoredEvalApproval; lastRequestId?: string }
export interface ProductSourceView {
  sourceId: string; provider: ProductProvider; hasKey: boolean; linkedTo?: string; available: boolean;
  connectedBy: string; connectedAt: number; updatedAt: number; warning?: { status: 401 | 403; at: number }; vertex?: VertexSummary;
}
export interface ProductKeysView {
  revision: number; owner: string; sources: ProductSourceView[]; removed: Array<{ sourceId: string; provider: ProductProvider; recoverUntil: number }>;
  caps?: ProductCaps; ceiling?: ProductCeiling; evalBudget?: EvalBudget; evalApproval?: StoredEvalApproval;
  /** With evalApproval: whether the stage hold would take it now ("current"), or it must be approved again. */
  evalApprovalState?: EvalApprovalState;
  /** There is never pending work (one transaction per change); the last applied request id is shown for support. */
  pending: false; lastRequestId?: string;
}
export type EvalApprovalState = "current" | "stale" | "withdrawn";
/** What the product route needs: the effective caps and which row to unseal. Never the key. */
export interface ProductSourceResolution { sourceId: string; owner: string; provider: ProductProvider; caps: ProductCaps; companyMonthMicros?: number; versionId: string }

const prefix = (iss: string, cid: string) => `CO#${JSON.stringify([iss, cid])}`;
const docKey = (iss: string, cid: string, owner: string) => `${prefix(iss, cid)}#doc#${owner}`;
const keyRowKey = (iss: string, cid: string, owner: string, sourceId: string, versionId: string) => `${prefix(iss, cid)}#key#${owner}#${sourceId}#${versionId}`;
const receiptKey = (iss: string, cid: string, owner: string, requestId: string) => `${prefix(iss, cid)}#req#${owner}#${requestId}`;
const auditKey = (iss: string, cid: string, owner: string, revision: number) => `${prefix(iss, cid)}#audit#${owner}#${revision}`;
/** The company's withdrawn eval approvals: whose, and up to when (one row per company; see withdrawApprovals). */
const withdrawalsKey = (iss: string, cid: string) => `${prefix(iss, cid)}#withdrawn#eval-approvals`;
interface Withdrawals { people: Record<string, number>; allBefore?: number }
function parseWithdrawals(value: unknown): Withdrawals {
  const w = record(value); const people = record(w?.people);
  if (w === undefined || people === undefined || !Object.keys(w).every((k) => k === "people" || k === "allBefore") || (w.allBefore !== undefined && !whole(w.allBefore))
    || Object.keys(people).length > APPROVAL_WITHDRAWALS_MAX || !Object.entries(people).every(([person, at]) => PERSON.test(person) && whole(at))) throw new ProductKeyError("unavailable");
  return { people: { ...(people as Record<string, number>) }, ...(w.allBefore === undefined ? {} : { allBefore: w.allBefore }) };
}
/** An approval made at or before its approver's withdrawal (or a company-wide one) no longer counts. */
const withdrawn = (approval: StoredEvalApproval, w: Withdrawals): boolean =>
  approval.approvedAt <= (w.allBefore ?? -1) || (Object.hasOwn(w.people, approval.approver.personId) && approval.approvedAt <= w.people[approval.approver.personId]!);
/** Fresh: made within EVAL_APPROVAL_FRESH_MS before `now`, and not in the future. */
export const freshApproval = (approval: Pick<StoredEvalApproval, "approvedAt">, now: number): boolean => approval.approvedAt <= now && now - approval.approvedAt < EVAL_APPROVAL_FRESH_MS;

const micros = (v: unknown): v is number => whole(v) && v <= 1_000_000_000_000;
function validCapsValue(v: unknown): v is ProductCaps {
  const c = record(v); return c !== undefined && Object.keys(c).every((k) => k === "taskMicros" || k === "projectMonthMicros") && micros(c.taskMicros) && micros(c.projectMonthMicros);
}
const EVAL_TEXT = /^[\x21-\x7e][\x20-\x7e]{0,511}$/u;
export function validEvalBudget(v: unknown): v is EvalBudget {
  const b = record(v); return b !== undefined && Object.keys(b).every((k) => k === "calls" || k === "costMicros") && whole(b.calls) && b.calls >= 1 && b.calls <= 100_000 && micros(b.costMicros) && b.costMicros >= 1;
}
export function validStoredEvalApproval(v: unknown): v is StoredEvalApproval {
  const a = record(v); const approver = record(a?.approver);
  return a !== undefined && approver !== undefined && Object.keys(a).every((k) => ["selection", "inputsDigest", "maxCalls", "maxCostMicros", "model", "approver", "role", "approvedAt"].includes(k))
    && typeof a.selection === "string" && EVAL_TEXT.test(a.selection) && typeof a.inputsDigest === "string" && /^[a-f0-9]{64}$/u.test(a.inputsDigest)
    && whole(a.maxCalls) && a.maxCalls >= 1 && a.maxCalls <= 100_000 && micros(a.maxCostMicros) && a.maxCostMicros >= 1
    && (a.model === undefined || (typeof a.model === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(a.model)))
    && Object.keys(approver).length === 2 && typeof approver.personId === "string" && PERSON.test(approver.personId) && typeof approver.provider === "string" && /^[a-z0-9-]{1,32}$/u.test(approver.provider)
    && (a.role === "owner" || a.role === "admin" || a.role === "maintainer") && whole(a.approvedAt);
}
function validCeiling(v: unknown): v is ProductCeiling {
  const c = record(v); return c !== undefined && Object.keys(c).every((k) => ["taskMicros", "projectMonthMicros", "companyMonthMicros"].includes(k)) && Object.values(c).every(micros);
}
/** Clamp project caps by the company ceiling (DEC 157). */
export function clampProductCaps(caps: ProductCaps, ceiling: ProductCeiling = {}): ProductCaps {
  return { taskMicros: Math.min(caps.taskMicros, ceiling.taskMicros ?? caps.taskMicros), projectMonthMicros: Math.min(caps.projectMonthMicros, ceiling.projectMonthMicros ?? caps.projectMonthMicros, ceiling.companyMonthMicros ?? caps.projectMonthMicros) };
}
/** Bounded shape check of a stored document. Anything unexpected is "unavailable", never a guess. */
function parseDoc(value: unknown): OwnerDoc {
  const d = record(value);
  const source = (s: unknown): s is SourceRecord => {
    const r = record(s);
    return r !== undefined && typeof r.sourceId === "string" && PRODUCT_SOURCE_ID.test(r.sourceId) && PRODUCT_PROVIDERS.some((p) => p === r.provider) && typeof r.connectedBy === "string" && PERSON.test(r.connectedBy)
      && whole(r.connectedAt) && whole(r.updatedAt) && ((r.currentVersion === undefined) !== (r.link === undefined)) && (r.currentVersion === undefined || (typeof r.currentVersion === "string" && UUID.test(r.currentVersion))) && (r.link === undefined || (typeof r.link === "string" && PRODUCT_SOURCE_ID.test(r.link) && whole(r.linkedAt))) && (r.link !== undefined || r.linkedAt === undefined)
      // A Vertex own key carries its summary; nothing else does.
      && (r.provider === "vertex" && r.currentVersion !== undefined ? validVertexSummary(r.vertex) : r.vertex === undefined);
  };
  if (d === undefined || !Array.isArray(d.sources) || d.sources.length > PRODUCT_MAX_SOURCES || !d.sources.every(source) || !Array.isArray(d.removed) || d.removed.length > 4 * PRODUCT_MAX_SOURCES
    || !d.removed.every((r: unknown) => { const x = record(r); return x !== undefined && source(x.source) && whole(x.removedAt) && whole(x.recoverUntil); })
    || (d.caps !== undefined && !validCapsValue(d.caps)) || (d.ceiling !== undefined && !validCeiling(d.ceiling))
    || (d.evalBudget !== undefined && !validEvalBudget(d.evalBudget)) || (d.evalApproval !== undefined && !validStoredEvalApproval(d.evalApproval))) throw new ProductKeyError("unavailable");
  return structuredClone(d) as unknown as OwnerDoc;
}
/** Gemini (AI Studio) keys are one printable token. Vertex credentials are JSON (product-vertex-credential.ts). */
const validGeminiKey = (key: unknown): key is string => typeof key === "string" && /^[\x21-\x7e]{8,512}$/u.test(key);

/**
 * The Vertex connection test (VertexTokens.probe, bound to the deployment), run for the change's company before a Vertex
 * credential is sealed: "ok" saves; "too_open" (the pool would trust another Rovara company), "refused" or "unavailable" saves
 * nothing. Without it, Vertex can't be connected (fail closed).
 */
export type VertexCheck = (cid: string, credential: VertexCredential) => Promise<"ok" | "too_open" | "refused" | "unavailable">;
export interface ProductKeyStoreOptions { table: ProductKeyTable; sealer: ProductKeySealer; fingerprint: ProductKeyFingerprinter; now?: () => number; providers?: readonly ProductProvider[]; vertexCheck?: VertexCheck }
interface Change { iss: string; cid: string; owner: string; requestId: string; expectedRevision: number; actor: ProductActor }

export class ProductKeyStore {
  readonly #now: () => number;
  readonly #providers: ReadonlySet<ProductProvider>;
  constructor(private readonly options: ProductKeyStoreOptions) { this.#now = options.now ?? Date.now; this.#providers = new Set(options.providers ?? PRODUCT_PROVIDERS); }

  // ---- reads ----
  async view(iss: string, cid: string, owner: string): Promise<ProductKeysView> {
    this.#identity(iss, cid, owner);
    const { revision, doc } = await this.#read(iss, cid, owner);
    const company = owner === PRODUCT_COMPANY_OWNER ? undefined : doc.sources.some((s) => s.link !== undefined) ? (await this.#read(iss, cid, PRODUCT_COMPANY_OWNER)).doc : undefined;
    const view = this.#view(owner, revision, doc, company);
    if (view.evalApproval !== undefined) view.evalApprovalState = this.#approvalState(view.evalApproval, await this.#withdrawals(iss, cid), this.#now());
    return view;
  }
  /** Company sources a project may link to. A removed source is never offered (F1-d M1). */
  async choices(iss: string, cid: string): Promise<Array<{ sourceId: string; provider: ProductProvider }>> {
    this.#identity(iss, cid, PRODUCT_COMPANY_OWNER);
    return (await this.#read(iss, cid, PRODUCT_COMPANY_OWNER)).doc.sources.map((s) => ({ sourceId: s.sourceId, provider: s.provider }));
  }
  /** The project's product caps (its own or the defaults, clamped by the company ceiling), whether or not a source is connected. */
  async capsFor(iss: string, cid: string, project: string): Promise<{ caps: ProductCaps; companyMonthMicros?: number }> {
    if (!PROJECT.test(project)) throw new ProductKeyError("invalid");
    this.#identity(iss, cid, project);
    const own = (await this.#read(iss, cid, project)).doc;
    const company = (await this.#read(iss, cid, PRODUCT_COMPANY_OWNER)).doc;
    return { caps: clampProductCaps(own.caps ?? PRODUCT_DEFAULT_CAPS, company.ceiling), ...(company.ceiling?.companyMonthMicros === undefined ? {} : { companyMonthMicros: company.ceiling.companyMonthMicros }) };
  }
  /** The project's source for a provider (its own, or a live company source it links to), with clamped caps. */
  async resolve(iss: string, cid: string, project: string, provider: ProductProvider): Promise<ProductSourceResolution | undefined> {
    if (!PROJECT.test(project)) return undefined;
    this.#identity(iss, cid, project);
    const own = (await this.#read(iss, cid, project)).doc;
    const company = (await this.#read(iss, cid, PRODUCT_COMPANY_OWNER)).doc;
    const caps = clampProductCaps(own.caps ?? PRODUCT_DEFAULT_CAPS, company.ceiling);
    const source = own.sources.find((s) => s.provider === provider);
    if (source === undefined) return undefined;
    const target = source.link === undefined ? { owner: project, record: source } : { owner: PRODUCT_COMPANY_OWNER, record: company.sources.find((s) => s.sourceId === source.link && s.connectedAt === source.linkedAt && s.provider === provider) };
    if (target.record?.currentVersion === undefined) return undefined;
    return { sourceId: target.record.sourceId, owner: target.owner, provider, caps, versionId: target.record.currentVersion, ...(company.ceiling?.companyMonthMicros === undefined ? {} : { companyMonthMicros: company.ceiling.companyMonthMicros }) };
  }
  /**
   * A project's eval budget (its own or the default) and its current approval record with its state now, for the eval hold
   * (eval-approvals.ts). Never a key. A withdrawal row that can't be read or parsed fails the read (unavailable): never a guess.
   */
  async evalFor(iss: string, cid: string, project: string): Promise<{ budget?: EvalBudget; approval?: StoredEvalApproval; approvalState?: EvalApprovalState }> {
    if (!PROJECT.test(project)) throw new ProductKeyError("invalid");
    this.#identity(iss, cid, project);
    const doc = (await this.#read(iss, cid, project)).doc;
    const budget = doc.evalBudget === undefined ? {} : { budget: { ...doc.evalBudget } };
    if (doc.evalApproval === undefined) return budget;
    return { ...budget, approval: structuredClone(doc.evalApproval), approvalState: this.#approvalState(doc.evalApproval, await this.#withdrawals(iss, cid), this.#now()) };
  }
  /** The company's learning account for a provider (LEARNING_OWNER), or undefined. Never the key. */
  async learningSource(iss: string, cid: string, provider: LearningKeyProvider): Promise<ProductSourceResolution | undefined> {
    this.#identity(iss, cid, LEARNING_OWNER);
    if (!LEARNING_KEY_PROVIDERS.includes(provider)) return undefined;
    const doc = (await this.#read(iss, cid, LEARNING_OWNER)).doc;
    const source = doc.sources.find((s) => s.provider === provider && s.currentVersion !== undefined);
    if (source?.currentVersion === undefined) return undefined;
    return { sourceId: source.sourceId, owner: LEARNING_OWNER, provider, caps: { ...PRODUCT_DEFAULT_CAPS }, versionId: source.currentVersion };
  }
  /**
   * PRODUCT-EVAL-APPROVER-REREAD: Cloud learned that this person's membership or role changed, so every eval approval they made up
   * to now stops counting at once, in every project of the company (the stage hold reads this row with the approval). One
   * conditional write on the company's withdrawal row; entries older than twice the approval's freshness are dropped (their
   * approvals are stale anyway), and past APPROVAL_WITHDRAWALS_MAX people every approval made up to now is withdrawn. Throws
   * (unavailable) when it could not be saved: the caller must not report the change as done.
   */
  async withdrawApprovals(iss: string, cid: string, personId: string): Promise<void> {
    this.#identity(iss, cid, PRODUCT_COMPANY_OWNER);
    if (typeof personId !== "string" || !PERSON.test(personId)) throw new ProductKeyError("invalid");
    for (let attempt = 0; attempt < 3; attempt++) {
      let row: StoredRow | undefined;
      try { row = await this.options.table.get(withdrawalsKey(iss, cid)); } catch { throw new ProductKeyError("unavailable"); }
      const current = row === undefined ? { people: {} } : parseWithdrawals(row.item);
      const now = this.#now();
      const people = Object.fromEntries(Object.entries(current.people).filter(([, at]) => at > now - 2 * EVAL_APPROVAL_FRESH_MS));
      people[personId] = Math.max(now, people[personId] ?? 0);
      const next: Withdrawals = Object.keys(people).length > APPROVAL_WITHDRAWALS_MAX ? { people: {}, allBefore: Math.max(now, current.allBefore ?? 0) } : { people, ...(current.allBefore === undefined ? {} : { allBefore: current.allBefore }) };
      let ok: boolean;
      try { ok = await this.options.table.transact([{ key: withdrawalsKey(iss, cid), put: { ...next }, condition: row === undefined ? { absent: true } : { version: row.version } }]); } catch { throw new ProductKeyError("unavailable"); }
      if (ok) return;
    }
    throw new ProductKeyError("unavailable");
  }
  /** The ONLY way out for a key: the gateway's product route, after the hold. Undefined when the row is gone or not current. */
  async useKey(iss: string, cid: string, resolution: ProductSourceResolution): Promise<string | undefined> {
    const row = { iss, cid, owner: resolution.owner, sourceId: resolution.sourceId, versionId: resolution.versionId };
    const stored = await this.options.table.get(keyRowKey(iss, cid, row.owner, row.sourceId, row.versionId), { stage: CURRENT_STAGE });
    if (stored === undefined || typeof stored.item.sealed !== "string") return undefined;
    return this.options.sealer.open(stored.item.sealed, row);
  }

  // ---- changes ----
  async connect(change: Change & { sourceId: string; provider: ProductProvider; key: string }): Promise<ProductKeysView> {
    this.#check(change);
    if (!PRODUCT_SOURCE_ID.test(change.sourceId) || !this.#providers.has(change.provider)) throw new ProductKeyError("invalid");
    const secret = this.#secretOf(change.provider, change.key);
    // No connection test configured: a Vertex connect is refused before anything else runs (no fingerprint, no KMS call).
    if (secret.vertex !== undefined && this.options.vertexCheck === undefined) throw new ProductKeyError("unavailable");
    // Learning accounts live only in the company's learning document (DEC 226), and nothing else does: a project or the company's
    // product sources never hold an Anthropic or OpenAI account, and the learning document never holds a product-only provider.
    if (change.owner === LEARNING_OWNER ? !LEARNING_KEY_PROVIDERS.some((p) => p === change.provider) : LEARNING_ONLY.has(change.provider)) throw new ProductKeyError("invalid");
    const versionId = randomUUID();
    const keyPrint = await this.options.fingerprint({ cid: change.cid, owner: change.owner, sourceId: change.sourceId, key: secret.text });
    return this.#mutate(change, "connect", { sourceId: change.sourceId, provider: change.provider, keyPrint }, async (doc, now) => {
      this.#ensureNew(doc, change.sourceId, change.provider, change.owner, now);
      // The connection test runs only for a change that would apply (a replay or a stale revision never reaches Google).
      if (secret.vertex !== undefined) await this.#vertexCheck(change.cid, secret.vertex);
      const sealed = await this.options.sealer.seal(secret.text, { iss: change.iss, cid: change.cid, owner: change.owner, sourceId: change.sourceId, versionId });
      doc.sources.push({ sourceId: change.sourceId, provider: change.provider, connectedBy: change.actor.id, connectedAt: now, updatedAt: now, currentVersion: versionId, ...(secret.vertex === undefined ? {} : { vertex: vertexSummary(secret.vertex) }) });
      return [{ key: keyRowKey(change.iss, change.cid, change.owner, change.sourceId, versionId), put: { stage: CURRENT_STAGE, sealed, fingerprint: keyPrint, createdAt: now }, condition: { absent: true } }];
    });
  }
  /** A project uses a company source for its test calls: a link, never a copy. */
  async link(change: Change & { sourceId: string; companySourceId: string }): Promise<ProductKeysView> {
    this.#check(change);
    if (change.owner === PRODUCT_COMPANY_OWNER || change.owner === LEARNING_OWNER || !PRODUCT_SOURCE_ID.test(change.sourceId) || !PRODUCT_SOURCE_ID.test(change.companySourceId)) throw new ProductKeyError("invalid");
    const company = await this.#read(change.iss, change.cid, PRODUCT_COMPANY_OWNER);
    const target = company.doc.sources.find((s) => s.sourceId === change.companySourceId);
    if (target === undefined) throw new ProductKeyError("not_found");
    // Product test calls only: the company's learning account is never linked into a project.
    if (LEARNING_ONLY.has(target.provider)) throw new ProductKeyError("invalid");
    return this.#mutate(change, "link", { sourceId: change.sourceId, companySourceId: change.companySourceId }, (doc, now) => {
      this.#ensureNew(doc, change.sourceId, target.provider, change.owner, now);
      doc.sources.push({ sourceId: change.sourceId, provider: target.provider, connectedBy: change.actor.id, connectedAt: now, updatedAt: now, link: target.sourceId, linkedAt: target.connectedAt });
      // The company document's version is part of the transaction: a link can't commit against a source removed meanwhile.
      return [{ key: docKey(change.iss, change.cid, PRODUCT_COMPANY_OWNER), check: { version: company.revision } }];
    });
  }
  async rotate(change: Change & { sourceId: string; key: string }): Promise<ProductKeysView> {
    this.#check(change);
    if (!PRODUCT_SOURCE_ID.test(change.sourceId) || typeof change.key !== "string") throw new ProductKeyError("invalid");
    const versionId = randomUUID();
    // The provider is known only inside the transaction, so the change's own text is fingerprinted (as before Vertex).
    const keyPrint = await this.options.fingerprint({ cid: change.cid, owner: change.owner, sourceId: change.sourceId, key: change.key });
    return this.#mutate(change, "rotate", { sourceId: change.sourceId, keyPrint }, async (doc, now) => {
      const source = doc.sources.find((s) => s.sourceId === change.sourceId);
      if (source === undefined) throw new ProductKeyError("not_found");
      if (source.currentVersion === undefined) throw new ProductKeyError("invalid");
      const secret = this.#secretOf(source.provider, change.key);
      if (secret.vertex !== undefined) await this.#vertexCheck(change.cid, secret.vertex);
      const old = source.currentVersion;
      const sealed = await this.options.sealer.seal(secret.text, { iss: change.iss, cid: change.cid, owner: change.owner, sourceId: change.sourceId, versionId });
      source.currentVersion = versionId; source.updatedAt = now; delete source.warning;
      if (secret.vertex !== undefined) source.vertex = vertexSummary(secret.vertex);
      return [
        { key: keyRowKey(change.iss, change.cid, change.owner, change.sourceId, versionId), put: { stage: CURRENT_STAGE, sealed, fingerprint: keyPrint, createdAt: now }, condition: { absent: true } },
        { key: keyRowKey(change.iss, change.cid, change.owner, change.sourceId, old), merge: { stage: "AWSPREVIOUS", purgeAfter: Math.floor((now + PRODUCT_RECOVERY_DAYS * DAY_MS) / 1000) }, condition: { exists: true } },
      ];
    });
  }
  /** Removal schedules the key's deletion with a 7-day recovery window. A company source stops answering for every linked project at once. */
  async remove(change: Change & { sourceId: string }): Promise<ProductKeysView> {
    this.#check(change);
    if (!PRODUCT_SOURCE_ID.test(change.sourceId)) throw new ProductKeyError("invalid");
    return this.#mutate(change, "remove", { sourceId: change.sourceId }, (doc, now) => {
      const at = doc.sources.findIndex((s) => s.sourceId === change.sourceId);
      if (at < 0) throw new ProductKeyError("not_found");
      const [source] = doc.sources.splice(at, 1) as [SourceRecord];
      const recoverUntil = now + PRODUCT_RECOVERY_DAYS * DAY_MS;
      if (source.currentVersion === undefined) return []; // An unlinked link holds no key.
      doc.removed.push({ source, removedAt: now, recoverUntil });
      return [{ key: keyRowKey(change.iss, change.cid, change.owner, change.sourceId, source.currentVersion), merge: { stage: "scheduled_deletion", purgeAfter: Math.floor(recoverUntil / 1000) }, condition: { exists: true } }];
    });
  }
  /** Restores a removed source inside its window, with the same key. After the window: not found. */
  async recover(change: Change & { sourceId: string }): Promise<ProductKeysView> {
    this.#check(change);
    if (!PRODUCT_SOURCE_ID.test(change.sourceId)) throw new ProductKeyError("invalid");
    return this.#mutate(change, "recover", { sourceId: change.sourceId }, (doc, now) => {
      const at = doc.removed.findIndex((r) => r.source.sourceId === change.sourceId && r.recoverUntil > now);
      if (at < 0) throw new ProductKeyError("not_found");
      const [removed] = doc.removed.splice(at, 1) as [RemovedRecord];
      if (doc.sources.length >= PRODUCT_MAX_SOURCES || (change.owner !== PRODUCT_COMPANY_OWNER && doc.sources.some((s) => s.provider === removed.source.provider))) throw new ProductKeyError("invalid");
      doc.sources.push({ ...removed.source, updatedAt: now });
      return [{ key: keyRowKey(change.iss, change.cid, change.owner, change.sourceId, removed.source.currentVersion!), merge: { stage: CURRENT_STAGE, purgeAfter: null }, condition: { exists: true } }];
    });
  }
  async setCaps(change: Change & { caps: ProductCaps }): Promise<ProductKeysView> {
    this.#check(change);
    if (!PROJECT.test(change.owner) || !validCapsValue(change.caps)) throw new ProductKeyError("invalid");
    return this.#mutate(change, "caps", { caps: change.caps }, (doc) => { doc.caps = { taskMicros: change.caps.taskMicros, projectMonthMicros: change.caps.projectMonthMicros }; return []; });
  }
  async setCeiling(change: Change & { ceiling: ProductCeiling }): Promise<ProductKeysView> {
    this.#check(change);
    if (change.owner !== PRODUCT_COMPANY_OWNER || !validCeiling(change.ceiling)) throw new ProductKeyError("invalid");
    return this.#mutate(change, "ceiling", { ceiling: change.ceiling }, (doc) => { doc.ceiling = { ...change.ceiling }; return []; });
  }
  /** The project's eval budget per stage run (DEC 203). Same roles as the project's caps. */
  async setEvalBudget(change: Change & { budget: EvalBudget }): Promise<ProductKeysView> {
    this.#check(change);
    if (!PROJECT.test(change.owner) || !validEvalBudget(change.budget)) throw new ProductKeyError("invalid");
    return this.#mutate(change, "eval_budget", { budget: change.budget }, (doc) => { doc.evalBudget = { calls: change.budget.calls, costMicros: change.budget.costMicros }; return []; });
  }
  /**
   * Records (or with null, withdraws) the project's approved eval spend. The approver is the actor: the settings route checked
   * that person's role with Code just before. A company admin approves as "admin", a project maintainer as "maintainer".
   * `roleCheckedAt`: when that role check began. The approval counts from then, not from the save, so a withdrawal made while
   * the check was in flight (withdrawApprovals) still catches it, and its freshness runs from what Code said.
   */
  async setEvalApproval(change: Change & { approval: Omit<StoredEvalApproval, "approver" | "role" | "approvedAt"> | null; provider: string; roleCheckedAt?: number }): Promise<ProductKeysView> {
    this.#check(change);
    if (!PROJECT.test(change.owner)) throw new ProductKeyError("invalid");
    if (change.roleCheckedAt !== undefined && !whole(change.roleCheckedAt)) throw new ProductKeyError("invalid");
    const now = Math.min(this.#now(), change.roleCheckedAt ?? Number.MAX_SAFE_INTEGER);
    const stored: StoredEvalApproval | null = change.approval === null ? null : {
      selection: change.approval.selection, inputsDigest: change.approval.inputsDigest, maxCalls: change.approval.maxCalls, maxCostMicros: change.approval.maxCostMicros,
      ...(change.approval.model === undefined ? {} : { model: change.approval.model }),
      approver: { personId: change.actor.id, provider: change.provider }, role: change.actor.role === "company_admin" ? "admin" : "maintainer", approvedAt: now,
    };
    if (stored !== null && (record(change.approval) === undefined || !validStoredEvalApproval(stored))) throw new ProductKeyError("invalid");
    return this.#mutate(change, "eval_approval", { approval: stored === null ? null : { ...stored, approvedAt: 0 } }, (doc) => { if (stored === null) delete doc.evalApproval; else doc.evalApproval = stored; return []; });
  }
  /** After a provider 401/403 on a product call, for the settings page. Never throws; a lost race is dropped. */
  async recordWarning(iss: string, cid: string, resolution: ProductSourceResolution, status: 401 | 403): Promise<void> {
    try {
      const { revision, doc } = await this.#read(iss, cid, resolution.owner);
      const source = doc.sources.find((s) => s.sourceId === resolution.sourceId);
      // Only the version the call used: a late 401 from the old key never marks a freshly rotated key (REVIEW-1 L3).
      if (source === undefined || revision === 0 || source.currentVersion !== resolution.versionId) return;
      source.warning = { status, at: this.#now() };
      await this.options.table.transact([{ key: docKey(iss, cid, resolution.owner), put: this.#docItem(doc), condition: { version: revision } }]);
    } catch { /* A warning never changes a call. */ }
  }

  // ---- internals ----
  /** The text to seal: a Gemini key as given, a Vertex credential in its canonical form (only the fields the token flow needs). */
  #secretOf(provider: ProductProvider, key: unknown): { text: string; vertex?: VertexCredential } {
    // Gemini (AI Studio), Anthropic and OpenAI (learning accounts) keys are one printable token.
    if (provider === "gemini" || provider === "anthropic" || provider === "openai") { if (!validGeminiKey(key)) throw new ProductKeyError("invalid"); return { text: key }; }
    const vertex = typeof key === "string" ? parseVertexConnect(key) : undefined;
    if (vertex === undefined) throw new ProductKeyError("invalid");
    return { text: serializeVertexCredential(vertex), vertex };
  }
  async #vertexCheck(cid: string, credential: VertexCredential): Promise<void> {
    if (this.options.vertexCheck === undefined) throw new ProductKeyError("unavailable");
    let result: Awaited<ReturnType<VertexCheck>>;
    try { result = await this.options.vertexCheck(cid, credential); } catch { throw new ProductKeyError("unavailable"); }
    if (result === "ok") return;
    throw new ProductKeyError(result === "too_open" || result === "refused" ? result : "unavailable");
  }
  #identity(iss: string, cid: string, owner: string): void {
    if (typeof iss !== "string" || iss.length === 0 || iss.length > 2048 || typeof cid !== "string" || !COMPANY.test(cid) || typeof owner !== "string" || (owner !== PRODUCT_COMPANY_OWNER && owner !== LEARNING_OWNER && !PROJECT.test(owner))) throw new ProductKeyError("invalid");
  }
  #check(change: Change): void {
    if (record(change) === undefined) throw new ProductKeyError("invalid");
    this.#identity(change.iss, change.cid, change.owner);
    const actor = record(change.actor);
    if (typeof change.requestId !== "string" || !UUID.test(change.requestId) || !whole(change.expectedRevision) || actor === undefined || typeof actor.id !== "string" || !PERSON.test(actor.id) || (actor.role !== "company_admin" && actor.role !== "project_maintainer")) throw new ProductKeyError("invalid");
    // DEC 157: a company admin OR a project maintainer may change a project's product key; company sources, the ceiling and the
    // learning accounts are admin-only.
    if ((change.owner === PRODUCT_COMPANY_OWNER || change.owner === LEARNING_OWNER) && actor.role !== "company_admin") throw new ProductKeyError("forbidden");
  }
  #ensureNew(doc: OwnerDoc, sourceId: string, provider: ProductProvider, owner: string, now: number): void {
    // Expired removals are dropped from the document here (the key rows expire by their own purge time).
    doc.removed = doc.removed.filter((r) => r.recoverUntil > now);
    // F1-d M2 (a): a source id inside its recovery window is refused BEFORE anything is written, so the document never freezes.
    if (doc.removed.some((r) => r.source.sourceId === sourceId)) throw new ProductKeyError("in_recovery");
    if (doc.sources.some((s) => s.sourceId === sourceId) || doc.sources.length >= PRODUCT_MAX_SOURCES) throw new ProductKeyError("invalid");
    // One source per provider per project, so the product route never has to guess.
    if (owner !== PRODUCT_COMPANY_OWNER && doc.sources.some((s) => s.provider === provider)) throw new ProductKeyError("invalid");
  }
  async #withdrawals(iss: string, cid: string): Promise<Withdrawals> {
    let row: StoredRow | undefined;
    try { row = await this.options.table.get(withdrawalsKey(iss, cid)); } catch { throw new ProductKeyError("unavailable"); }
    return row === undefined ? { people: {} } : parseWithdrawals(row.item);
  }
  #approvalState(approval: StoredEvalApproval, w: Withdrawals, now: number): EvalApprovalState {
    if (withdrawn(approval, w)) return "withdrawn";
    return freshApproval(approval, now) ? "current" : "stale";
  }
  async #read(iss: string, cid: string, owner: string): Promise<{ revision: number; doc: OwnerDoc }> {
    let row: StoredRow | undefined;
    try { row = await this.options.table.get(docKey(iss, cid, owner)); } catch { throw new ProductKeyError("unavailable"); }
    if (row === undefined) return { revision: 0, doc: { sources: [], removed: [] } };
    return { revision: row.version, doc: parseDoc(row.item) };
  }
  #docItem(doc: OwnerDoc): Record<string, unknown> { return structuredClone(doc) as unknown as Record<string, unknown>; }
  #view(owner: string, revision: number, doc: OwnerDoc, company?: OwnerDoc): ProductKeysView {
    const now = this.#now();
    return {
      revision, owner, pending: false, ...(doc.lastRequestId === undefined ? {} : { lastRequestId: doc.lastRequestId }),
      sources: doc.sources.map((s) => ({
        sourceId: s.sourceId, provider: s.provider, hasKey: s.currentVersion !== undefined, available: s.link === undefined || company?.sources.some((c) => c.sourceId === s.link && c.connectedAt === s.linkedAt) === true,
        connectedBy: s.connectedBy, connectedAt: s.connectedAt, updatedAt: s.updatedAt, ...(s.link === undefined ? {} : { linkedTo: s.link }), ...(s.warning === undefined ? {} : { warning: { ...s.warning } }), ...(s.vertex === undefined ? {} : { vertex: { ...s.vertex } }),
      })),
      removed: doc.removed.filter((r) => r.recoverUntil > now).map((r) => ({ sourceId: r.source.sourceId, provider: r.source.provider, recoverUntil: r.recoverUntil })),
      ...(owner === LEARNING_OWNER ? {} : owner === PRODUCT_COMPANY_OWNER ? (doc.ceiling === undefined ? {} : { ceiling: { ...doc.ceiling } }) : { caps: { ...(doc.caps ?? PRODUCT_DEFAULT_CAPS) } }),
      ...(!PROJECT.test(owner) ? {} : { evalBudget: { ...(doc.evalBudget ?? PRODUCT_DEFAULT_EVAL_BUDGET) }, ...(doc.evalApproval === undefined ? {} : { evalApproval: structuredClone(doc.evalApproval) }) }),
    };
  }
  async #mutate(change: Change, kind: string, intent: Record<string, unknown>, apply: (doc: OwnerDoc, now: number) => TableWrite[] | Promise<TableWrite[]>): Promise<ProductKeysView> {
    const now = this.#now();
    // The intent fingerprint is a keyed HMAC (it may cover a key fingerprint): replays must match it exactly.
    const fingerprint = await this.options.fingerprint({ cid: change.cid, owner: change.owner, sourceId: "intent", key: JSON.stringify([kind, change.requestId, change.actor.id, intent]) });
    let receipt: StoredRow | undefined;
    try { receipt = await this.options.table.get(receiptKey(change.iss, change.cid, change.owner, change.requestId)); } catch { throw new ProductKeyError("unavailable"); }
    if (receipt !== undefined) {
      if (!whole(receipt.item.expiresAt) || receipt.item.expiresAt <= Math.floor(now / 1000)) throw new ProductKeyError("stale");
      if (receipt.item.fingerprint !== fingerprint) throw new ProductKeyError("invalid");
      return this.view(change.iss, change.cid, change.owner);
    }
    const { revision, doc } = await this.#read(change.iss, change.cid, change.owner);
    if (revision !== change.expectedRevision) throw new ProductKeyError("stale");
    const extra = await apply(doc, now);
    doc.lastRequestId = change.requestId;
    const writes: TableWrite[] = [
      { key: docKey(change.iss, change.cid, change.owner), put: this.#docItem(doc), condition: revision === 0 ? { absent: true } : { version: revision } },
      ...extra,
      { key: receiptKey(change.iss, change.cid, change.owner, change.requestId), put: { fingerprint, expiresAt: Math.floor(now / 1000) + PRODUCT_RECEIPT_SECONDS }, condition: { absent: true } },
      // Audit row in the same transaction: who, what, which source. Never the key or its fingerprint.
      { key: auditKey(change.iss, change.cid, change.owner, revision + 1), put: { action: `product_ai.${kind}`, by: change.actor.id, role: change.actor.role, requestId: change.requestId, revision: revision + 1, at: now, ...(typeof intent.sourceId === "string" ? { sourceId: intent.sourceId } : {}) }, condition: { absent: true } },
    ];
    let ok: boolean;
    try { ok = await this.options.table.transact(writes); } catch { throw new ProductKeyError("unavailable"); }
    if (!ok) throw new ProductKeyError("stale");
    return this.view(change.iss, change.cid, change.owner);
  }
}
