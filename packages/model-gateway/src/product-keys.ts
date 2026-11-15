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

export const PRODUCT_COMPANY_OWNER = "_company";
export const PRODUCT_PROVIDERS = ["gemini", "vertex"] as const;
export type ProductProvider = typeof PRODUCT_PROVIDERS[number];
export const PRODUCT_MAX_SOURCES = 20;
export const PRODUCT_RECOVERY_DAYS = 7;
export const PRODUCT_RECEIPT_SECONDS = 86_400;
const DAY_MS = 86_400_000;
/** DEC 157: Rovara suggests $2 per task at connect time; the company ceiling, when set, caps every project. */
export const PRODUCT_DEFAULT_CAPS: Readonly<ProductCaps> = Object.freeze({ taskMicros: 2_000_000, projectMonthMicros: 50_000_000 });
export const PRODUCT_SOURCE_ID = /^src_[a-z0-9]{1,32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const CURRENT_STAGE = "AWSCURRENT";

export interface ProductCaps { taskMicros: number; projectMonthMicros: number }
export interface ProductCeiling { taskMicros?: number; projectMonthMicros?: number; companyMonthMicros?: number }
export type ProductRole = "company_admin" | "project_maintainer";
/** The caller (Cloud's settings route) has checked the person's role with Code; the store re-checks what the role may change. */
export interface ProductActor { id: string; role: ProductRole }

export type ProductKeyErrorCode = "invalid" | "stale" | "not_found" | "in_recovery" | "forbidden" | "unavailable";
const MESSAGES: Record<ProductKeyErrorCode, string> = {
  invalid: "These product AI settings are not valid.",
  stale: "Product AI settings changed. Refresh and try again.",
  not_found: "Product AI source not found.",
  in_recovery: "This source was removed less than 7 days ago. Recover it, or connect it under a new source id.",
  forbidden: "You can't change these product AI settings.",
  unavailable: "Product AI settings are unavailable right now. Try again.",
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
}
interface RemovedRecord { source: SourceRecord; removedAt: number; recoverUntil: number }
interface OwnerDoc { sources: SourceRecord[]; removed: RemovedRecord[]; caps?: ProductCaps; ceiling?: ProductCeiling; lastRequestId?: string }
export interface ProductSourceView {
  sourceId: string; provider: ProductProvider; hasKey: boolean; linkedTo?: string; available: boolean;
  connectedBy: string; connectedAt: number; updatedAt: number; warning?: { status: 401 | 403; at: number };
}
export interface ProductKeysView {
  revision: number; owner: string; sources: ProductSourceView[]; removed: Array<{ sourceId: string; provider: ProductProvider; recoverUntil: number }>;
  caps?: ProductCaps; ceiling?: ProductCeiling;
  /** There is never pending work (one transaction per change); the last applied request id is shown for support. */
  pending: false; lastRequestId?: string;
}
/** What the product route needs: the effective caps and which row to unseal. Never the key. */
export interface ProductSourceResolution { sourceId: string; owner: string; provider: ProductProvider; caps: ProductCaps; companyMonthMicros?: number; versionId: string }

const prefix = (iss: string, cid: string) => `CO#${JSON.stringify([iss, cid])}`;
const docKey = (iss: string, cid: string, owner: string) => `${prefix(iss, cid)}#doc#${owner}`;
const keyRowKey = (iss: string, cid: string, owner: string, sourceId: string, versionId: string) => `${prefix(iss, cid)}#key#${owner}#${sourceId}#${versionId}`;
const receiptKey = (iss: string, cid: string, owner: string, requestId: string) => `${prefix(iss, cid)}#req#${owner}#${requestId}`;
const auditKey = (iss: string, cid: string, owner: string, revision: number) => `${prefix(iss, cid)}#audit#${owner}#${revision}`;

const micros = (v: unknown): v is number => whole(v) && v <= 1_000_000_000_000;
function validCapsValue(v: unknown): v is ProductCaps {
  const c = record(v); return c !== undefined && Object.keys(c).every((k) => k === "taskMicros" || k === "projectMonthMicros") && micros(c.taskMicros) && micros(c.projectMonthMicros);
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
      && whole(r.connectedAt) && whole(r.updatedAt) && ((r.currentVersion === undefined) !== (r.link === undefined)) && (r.currentVersion === undefined || (typeof r.currentVersion === "string" && UUID.test(r.currentVersion))) && (r.link === undefined || (typeof r.link === "string" && PRODUCT_SOURCE_ID.test(r.link) && whole(r.linkedAt))) && (r.link !== undefined || r.linkedAt === undefined);
  };
  if (d === undefined || !Array.isArray(d.sources) || d.sources.length > PRODUCT_MAX_SOURCES || !d.sources.every(source) || !Array.isArray(d.removed) || d.removed.length > 4 * PRODUCT_MAX_SOURCES
    || !d.removed.every((r: unknown) => { const x = record(r); return x !== undefined && source(x.source) && whole(x.removedAt) && whole(x.recoverUntil); })
    || (d.caps !== undefined && !validCapsValue(d.caps)) || (d.ceiling !== undefined && !validCeiling(d.ceiling))) throw new ProductKeyError("unavailable");
  return structuredClone(d) as unknown as OwnerDoc;
}
function validKey(provider: ProductProvider, key: unknown): key is string {
  if (typeof key !== "string") return false;
  // Gemini (AI Studio) keys are one printable token. A Vertex key file is JSON (the follow-up federation lane parses it).
  return provider === "gemini" ? /^[\x21-\x7e]{8,512}$/u.test(key) : key.length >= 8 && key.length <= 16_384 && !/[\0]/u.test(key);
}

export interface ProductKeyStoreOptions { table: ProductKeyTable; sealer: ProductKeySealer; fingerprint: ProductKeyFingerprinter; now?: () => number; providers?: readonly ProductProvider[] }
interface Change { iss: string; cid: string; owner: string; requestId: string; expectedRevision: number; actor: ProductActor }

export class ProductKeyStore {
  readonly #now: () => number;
  readonly #providers: ReadonlySet<ProductProvider>;
  constructor(private readonly options: ProductKeyStoreOptions) { this.#now = options.now ?? Date.now; this.#providers = new Set(options.providers ?? ["gemini"]); }

  // ---- reads ----
  async view(iss: string, cid: string, owner: string): Promise<ProductKeysView> {
    this.#identity(iss, cid, owner);
    const { revision, doc } = await this.#read(iss, cid, owner);
    const company = owner === PRODUCT_COMPANY_OWNER ? undefined : doc.sources.some((s) => s.link !== undefined) ? (await this.#read(iss, cid, PRODUCT_COMPANY_OWNER)).doc : undefined;
    return this.#view(owner, revision, doc, company);
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
    if (!PRODUCT_SOURCE_ID.test(change.sourceId) || !this.#providers.has(change.provider) || !validKey(change.provider, change.key)) throw new ProductKeyError("invalid");
    const versionId = randomUUID();
    const keyPrint = await this.options.fingerprint({ cid: change.cid, owner: change.owner, sourceId: change.sourceId, key: change.key });
    return this.#mutate(change, "connect", { sourceId: change.sourceId, provider: change.provider, keyPrint }, async (doc, now) => {
      this.#ensureNew(doc, change.sourceId, change.provider, change.owner, now);
      const sealed = await this.options.sealer.seal(change.key, { iss: change.iss, cid: change.cid, owner: change.owner, sourceId: change.sourceId, versionId });
      doc.sources.push({ sourceId: change.sourceId, provider: change.provider, connectedBy: change.actor.id, connectedAt: now, updatedAt: now, currentVersion: versionId });
      return [{ key: keyRowKey(change.iss, change.cid, change.owner, change.sourceId, versionId), put: { stage: CURRENT_STAGE, sealed, fingerprint: keyPrint, createdAt: now }, condition: { absent: true } }];
    });
  }
  /** A project uses a company source for its test calls: a link, never a copy. */
  async link(change: Change & { sourceId: string; companySourceId: string }): Promise<ProductKeysView> {
    this.#check(change);
    if (change.owner === PRODUCT_COMPANY_OWNER || !PRODUCT_SOURCE_ID.test(change.sourceId) || !PRODUCT_SOURCE_ID.test(change.companySourceId)) throw new ProductKeyError("invalid");
    const company = await this.#read(change.iss, change.cid, PRODUCT_COMPANY_OWNER);
    const target = company.doc.sources.find((s) => s.sourceId === change.companySourceId);
    if (target === undefined) throw new ProductKeyError("not_found");
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
    const keyPrint = await this.options.fingerprint({ cid: change.cid, owner: change.owner, sourceId: change.sourceId, key: change.key });
    return this.#mutate(change, "rotate", { sourceId: change.sourceId, keyPrint }, async (doc, now) => {
      const source = doc.sources.find((s) => s.sourceId === change.sourceId);
      if (source === undefined) throw new ProductKeyError("not_found");
      if (source.currentVersion === undefined || !validKey(source.provider, change.key)) throw new ProductKeyError("invalid");
      const old = source.currentVersion;
      const sealed = await this.options.sealer.seal(change.key, { iss: change.iss, cid: change.cid, owner: change.owner, sourceId: change.sourceId, versionId });
      source.currentVersion = versionId; source.updatedAt = now; delete source.warning;
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
    if (change.owner === PRODUCT_COMPANY_OWNER || !validCapsValue(change.caps)) throw new ProductKeyError("invalid");
    return this.#mutate(change, "caps", { caps: change.caps }, (doc) => { doc.caps = { taskMicros: change.caps.taskMicros, projectMonthMicros: change.caps.projectMonthMicros }; return []; });
  }
  async setCeiling(change: Change & { ceiling: ProductCeiling }): Promise<ProductKeysView> {
    this.#check(change);
    if (change.owner !== PRODUCT_COMPANY_OWNER || !validCeiling(change.ceiling)) throw new ProductKeyError("invalid");
    return this.#mutate(change, "ceiling", { ceiling: change.ceiling }, (doc) => { doc.ceiling = { ...change.ceiling }; return []; });
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
  #identity(iss: string, cid: string, owner: string): void {
    if (typeof iss !== "string" || iss.length === 0 || iss.length > 2048 || typeof cid !== "string" || !COMPANY.test(cid) || typeof owner !== "string" || (owner !== PRODUCT_COMPANY_OWNER && !PROJECT.test(owner))) throw new ProductKeyError("invalid");
  }
  #check(change: Change): void {
    if (record(change) === undefined) throw new ProductKeyError("invalid");
    this.#identity(change.iss, change.cid, change.owner);
    const actor = record(change.actor);
    if (typeof change.requestId !== "string" || !UUID.test(change.requestId) || !whole(change.expectedRevision) || actor === undefined || typeof actor.id !== "string" || !PERSON.test(actor.id) || (actor.role !== "company_admin" && actor.role !== "project_maintainer")) throw new ProductKeyError("invalid");
    // DEC 157: a company admin OR a project maintainer may change a project's product key; company sources and the ceiling are admin-only.
    if (change.owner === PRODUCT_COMPANY_OWNER && actor.role !== "company_admin") throw new ProductKeyError("forbidden");
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
        connectedBy: s.connectedBy, connectedAt: s.connectedAt, updatedAt: s.updatedAt, ...(s.link === undefined ? {} : { linkedTo: s.link }), ...(s.warning === undefined ? {} : { warning: { ...s.warning } }),
      })),
      removed: doc.removed.filter((r) => r.recoverUntil > now).map((r) => ({ sourceId: r.source.sourceId, provider: r.source.provider, recoverUntil: r.recoverUntil })),
      ...(owner === PRODUCT_COMPANY_OWNER ? (doc.ceiling === undefined ? {} : { ceiling: { ...doc.ceiling } }) : { caps: { ...(doc.caps ?? PRODUCT_DEFAULT_CAPS) } }),
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
