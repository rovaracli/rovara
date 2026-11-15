// Cloud's own audit records (migration plan v3.2, 7.5 "Audit"): one record for each Cloud action (company rules changes, invites, budget changes,
// sign-in client changes) and one for each policy hook answer. Records are company-scoped and append-only from the API: the store has `append` and `read` and
// nothing else, `append` never replaces a record (the same id again is "exists"), and a record has no expiry. The company's audit page reads them next to Code's
// engine records (company-audit.ts). The tamper-evident ledger (sealing, timestamps) is P1 and is not here.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { isDeployedEnvironment } from "./sessions.js";

/** The Cloud actions that are recorded. Each is a name the audit list's `action` filter can match, exactly or by family (`hook.*`). */
export const CLOUD_AUDIT_ACTIONS = Object.freeze([
  "company.rules.changed", "company.invite.created", "company.invite.revoked", "company.budget.changed", "company.signin_client.changed",
  "hook.start.answered", "hook.decide.answered", "hook.values.answered", "hook.start.unanswered", "hook.decide.unanswered", "hook.values.unanswered",
] as const);
export type CloudAuditAction = (typeof CLOUD_AUDIT_ACTIONS)[number];

/** No record is older than this (Cloud and Code both start in 2026), so a read never looks further back. */
export const AUDIT_EARLIEST_MS = Date.UTC(2026, 0, 1);

export type AuditActorType = "person" | "agent" | "system";

export interface CloudAuditRecord {
  id: string;
  companyId: string;
  /** UTC with milliseconds (`Date.prototype.toISOString`), stamped by the server that recorded it. */
  at: string;
  actor: { developerId: string; name: string; type: AuditActorType };
  /** The caller the action came through: `web`, `policy-hook`, `client:<id>`. */
  via?: string;
  action: CloudAuditAction;
  /** `<type>:<id>`, or empty when the action was about the company as a whole. */
  subject: string;
  project?: string;
  outcome: "ok" | "refused";
  /** A short note of fixed words (an answer's code, what was asked): never free text from a person. */
  detail?: string;
}

/** The position of a record in the list's order: newest first, ties by id (higher first). */
export interface AuditStorePosition { atMs: number; id: string }

export interface CloudAuditRange {
  /** Inclusive. */
  fromMs?: number;
  /** Inclusive. */
  toMs?: number;
  /** Only records strictly after this position in the list's order (older, or the same instant with a lower id). */
  olderThan?: AuditStorePosition;
  /** The most rows to answer. */
  max: number;
}

/**
 * Where Cloud's audit records live. There is no update and no delete: a record, once appended, is read as it was written.
 */
export interface CloudAuditStore {
  /** Adds the record. "exists" when the company already has a record with that id (nothing is changed), which makes a repeated write harmless. */
  append(record: CloudAuditRecord): Promise<"added" | "exists">;
  /** One company's records, newest first (ties by id, higher first), at most `max`; `more` says whether older ones remain in the range. */
  read(companyId: string, range: CloudAuditRange): Promise<{ rows: CloudAuditRecord[]; more: boolean }>;
}

/** A record or a company that is not in the allowed shape: nothing was written or read. Fixed words, never the offending value. */
export class AuditRecordRefused extends Error {}

const COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/u;
// eslint-disable-next-line no-control-regex -- the control characters are what is refused
const SUBJECT = /^[a-z][a-z0-9_.-]{0,63}:[^\u0000-\u001f\u007f]{1,256}$/u;
const PROJECT = /^[a-z][a-z0-9-]{0,62}$/u;
const VIA = /^[a-z][a-z0-9_.:-]{0,63}$/u;
const AUDIT_ID = /^aud_[0-9a-z]{20}$/u;
// eslint-disable-next-line no-control-regex -- the control characters are what is refused
const PLAIN = /^[^\u0000-\u001f\u007f]*$/u;
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A company id as Cloud keeps them (`rovara`, `org_…`): never a `#`, which separates the parts of a key. */
export function checkedCompany(companyId: string): string {
  if (typeof companyId !== "string" || !COMPANY_ID.test(companyId)) throw new AuditRecordRefused("the company is not valid");
  return companyId;
}

const idFromBytes = (bytes: Uint8Array): string => `aud_${[...bytes.subarray(0, 20)].map((byte) => ALPHABET[byte % ALPHABET.length]).join("")}`;
/** A new record id in Cloud's format (`aud_` and 20 lower-case letters and digits). */
export function newAuditId(): string {
  return idFromBytes(randomBytes(20));
}
/** The same id for the same seed: a record about one hook question gets one id however often the question is asked. */
export function auditIdFrom(seed: string): string {
  return idFromBytes(createHash("sha256").update(seed, "utf8").digest());
}

export interface CloudActionInput {
  companyId: string;
  actor: { developerId: string; name: string; type?: AuditActorType };
  action: CloudAuditAction;
  subject?: string;
  project?: string;
  outcome?: "ok" | "refused";
  via?: string;
  detail?: string;
  /** Only for a record that must exist once however often it is written (`auditIdFrom(seed)`). Default: a new id. */
  id?: string;
}

/** The record an input makes, or AuditRecordRefused. The time is the server's own. */
export function buildAuditRecord(input: CloudActionInput, now: Date): CloudAuditRecord {
  const refuse = (what: string): never => { throw new AuditRecordRefused(`the audit record is not valid: ${what}`); };
  const companyId = checkedCompany(input.companyId);
  if (!(CLOUD_AUDIT_ACTIONS as readonly string[]).includes(input.action)) refuse("action");
  const time = now.getTime();
  if (Number.isNaN(time) || time < AUDIT_EARLIEST_MS) refuse("time");
  const developerId = input.actor.developerId;
  if (typeof developerId !== "string" || developerId.length < 1 || developerId.length > 256 || !PLAIN.test(developerId)) refuse("actor");
  const name = typeof input.actor.name === "string" ? input.actor.name.trim() : "";
  if (name.length < 1 || name.length > 200 || !PLAIN.test(name)) refuse("actor name");
  const type = input.actor.type ?? "person";
  if (type !== "person" && type !== "agent" && type !== "system") refuse("actor type");
  const subject = input.subject ?? "";
  if (subject !== "" && !SUBJECT.test(subject)) refuse("subject");
  if (input.project !== undefined && !PROJECT.test(input.project)) refuse("project");
  if (input.via !== undefined && !VIA.test(input.via)) refuse("via");
  if (input.detail !== undefined && (input.detail.length > 200 || !PLAIN.test(input.detail))) refuse("detail");
  const outcome = input.outcome ?? "ok";
  if (outcome !== "ok" && outcome !== "refused") refuse("outcome");
  const id = input.id ?? newAuditId();
  if (!AUDIT_ID.test(id)) refuse("id");
  return {
    id, companyId, at: now.toISOString(), actor: { developerId, name, type }, action: input.action, subject, outcome,
    ...(input.via === undefined ? {} : { via: input.via }), ...(input.project === undefined ? {} : { project: input.project }), ...(input.detail === undefined ? {} : { detail: input.detail }),
  };
}

/** Records a Cloud action for a company: checked, stamped with the server's time and appended. Answers the record. */
export async function recordCloudAction(store: Pick<CloudAuditStore, "append">, input: CloudActionInput, now: () => Date = () => new Date()): Promise<CloudAuditRecord> {
  const record = buildAuditRecord(input, now());
  await store.append(record);
  return record;
}

/** Whether a record is after the position in the list's order (older, or the same instant with a lower id). */
export function isOlderThan(atMs: number, id: string, position: AuditStorePosition): boolean {
  return atMs < position.atMs || (atMs === position.atMs && id < position.id);
}

/** Newest first, ties by id (higher first). */
export function newestFirst(a: { atMs: number; id: string }, b: { atMs: number; id: string }): number {
  return a.atMs === b.atMs ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : b.atMs - a.atMs;
}

function readableRecord(value: unknown, companyId: string): CloudAuditRecord | undefined {
  const row = value as Partial<CloudAuditRecord> | null | undefined;
  if (row === null || typeof row !== "object" || row.companyId !== companyId) return undefined;
  if (typeof row.id !== "string" || typeof row.at !== "string" || Number.isNaN(Date.parse(row.at)) || typeof row.action !== "string") return undefined;
  if (row.actor === undefined || typeof row.actor.developerId !== "string" || typeof row.actor.name !== "string") return undefined;
  return row as CloudAuditRecord;
}

interface LocalFileLine { record: CloudAuditRecord }

function loadLocal(file: string | undefined, rows: Map<string, CloudAuditRecord>): void {
  if (file === undefined) return;
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const { record } = JSON.parse(line) as LocalFileLine;
      const company = readableRecord(record, record.companyId);
      if (company !== undefined) rows.set(`${company.companyId}\u0000${company.id}`, company);
    } catch { /* a torn last line */ }
  }
}

/** Records in this server's memory, and with `file` also appended there (mode 600, one JSON line each) so a restart keeps them. For this computer only: refused when deployed. */
export class LocalCloudAuditStore implements CloudAuditStore {
  private readonly rows = new Map<string, CloudAuditRecord>();
  private readonly file: string | undefined;

  constructor(file?: string, environment: Record<string, string | undefined> = process.env) {
    if (isDeployedEnvironment(environment)) throw new Error("The local audit store is for local development only; a deployed Cloud keeps audit records in its table.");
    this.file = file;
    loadLocal(file, this.rows);
  }

  async append(record: CloudAuditRecord): Promise<"added" | "exists"> {
    const companyId = checkedCompany(record.companyId);
    const key = `${companyId}\u0000${record.id}`;
    if (this.rows.has(key)) return "exists";
    const stored = structuredClone(record);
    this.rows.set(key, stored);
    if (this.file !== undefined) {
      appendFileSync(this.file, `${JSON.stringify({ record: stored })}\n`, { mode: 0o600 });
    }
    return "added";
  }

  async read(companyId: string, range: CloudAuditRange): Promise<{ rows: CloudAuditRecord[]; more: boolean }> {
    checkedCompany(companyId);
    const low = Math.max(range.fromMs ?? AUDIT_EARLIEST_MS, AUDIT_EARLIEST_MS);
    const found = [...this.rows.values()]
      .filter((row) => row.companyId === companyId)
      .map((row) => ({ row, atMs: Date.parse(row.at), id: row.id }))
      .filter((entry) => entry.atMs >= low && (range.toMs === undefined || entry.atMs <= range.toMs) && (range.olderThan === undefined || isOlderThan(entry.atMs, entry.id, range.olderThan)))
      .sort(newestFirst);
    return { rows: found.slice(0, range.max).map((entry) => structuredClone(entry.row)), more: found.length > range.max };
  }
}

export { readableRecord };
