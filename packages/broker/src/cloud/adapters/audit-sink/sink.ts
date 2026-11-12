// Convergence A7 (`cloud/audit-sink`): Cloud's `AuditSink` on Rovara Code's port.
//
// `stage(event)` returns ONE document-store step: Cloud's audit outbox row (`AUDIT_PENDING#<shard>`, exactly the item `auditPendingItem` makes for Cloud's own flows: same key, same 14-day expiry, same
// shape), for the core to add to the transaction of the change it records. The row and the change commit together or not at all. Delivery is Cloud's, unchanged: the drain (every minute) sends pending
// rows to the intake queue and deletes them; the appender claims each event id, so a row sent twice is appended once. Nothing here sends to a queue or reads the ledger.
//
// `record(event)` writes the same row on its own (a put, unconditional as Cloud's is: a repeat of one occurrence overwrites an identical row), for a caller with no transaction.
//
// An event this sink cannot make into a valid Cloud event (no entry in the map, a company or actor the ledger would refuse, a target it cannot name, a required fact that failed its check) is, by default,
// REFUSED: `stage` and `record` throw `CloudAuditSinkError`, so the core's change is not made without its record (Code's own default sink does the same). That default is for TESTS AND CI, where a gap must be loud.
//
// PRODUCTION: THE COMPOSITION ROOT (lanes S0 / S3) MUST PASS `onInvalid: "skip"`. It mirrors `auditPending` in outbox.ts, which every Cloud flow uses today: log `audit.record_invalid` (a fixed reason word and the
// core's action name, never a value), add no step, and let the change go on. `audit.record_invalid` is already alarmed (`AUDIT_RECORD_FAILED_EVENTS`, infra/lib/audit-ledger.ts), so a dropped record is seen, and a
// bad or unmapped event can never stop a real action in production (a refusal would turn an audit gap into an outage of task start, merge and approval). docs/architecture/cloud-adapter-conformance.md says the same.
import { createHash } from "node:crypto";
import { AuditEventInputSchema, auditEventId, AUDIT_FACT_KEYS, AUDIT_FACT_MAX_CHARS, AUDIT_MAX_RELATED, AUDIT_DETAIL_FIELDS_MAX, AUDIT_DETAIL_FIELD_MAX_CHARS, type AuditActor, type AuditDetailPart, type AuditEventInput, type AuditTarget } from "@agentx/cloud-contracts";
import { DOCUMENT_STORE_LIMITS } from "@rovara-code/contracts";
import type { AuditEvent, AuditSink, DocumentStore, JsonObject, StoredDocument, TransactItem } from "@rovara-code/contracts";
import { auditPendingItem } from "../../../audit/outbox.js";
import { CORE_AUDIT_EVENT_MAP, RELATED_ID, checkedFact, valueOf, type EventMapping, type MappingContext, type TargetRule } from "./event-map.js";

/** Why an event could not be made into a Cloud event. Fixed words: the only thing a log or an error says. */
export type CloudAuditRefusal = "unmapped_action" | "bad_actor" | "bad_time" | "bad_target" | "invalid_event";

export class CloudAuditSinkError extends Error {
  constructor(readonly refusal: CloudAuditRefusal, readonly coreAction?: string) {
    super(`the audit ledger cannot take this event (${refusal})`);
    this.name = "CloudAuditSinkError";
  }
}

export interface CloudAuditSinkOptions {
  /** The State table's store, for `record`. Asked when `record` is called, so the registry's `storage` adapter is the one used. */
  store: () => Pick<DocumentStore, "put">;
  /** Milliseconds. Sets the row's creation time and expiry; default `Date.now`. */
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  /** `refuse` (default, for tests and CI): throw. `skip` (what the composition root passes in production): log `audit.record_invalid` and add nothing, as Cloud's own `auditPending` does. */
  onInvalid?: "refuse" | "skip";
  /** The core-to-Cloud map. Default: `CORE_AUDIT_EVENT_MAP`. Tests pass one with an entry added or dropped. */
  map?: Readonly<Record<string, EventMapping>>;
}

const ASCII = /^[\x20-\x7e]*$/u;
const EMAIL_SHAPED = /[^\s@]+@[^\s@]+\.[^\s@]+/u;

type Fact = string | number | boolean;

/** A fact value the ledger accepts (its own rules), or undefined. */
function factOf(value: unknown): Fact | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === "string") return value.length <= AUDIT_FACT_MAX_CHARS && ASCII.test(value) && !EMAIL_SHAPED.test(value) ? value : undefined;
  return undefined;
}

function actorOf(event: AuditEvent): { actor: AuditActor; related: string[] } | undefined {
  const { type, id } = event.actor;
  if (type === "system") return { actor: { kind: "system", id: "rovara" }, related: [] };
  if (id.length < 1 || id.length > 100) return undefined;
  if (type === "person") return { actor: { kind: "member", id }, related: [] };
  // An agent acts for the company: the ledger has no agent actor, so the system acts and the agent's id is a related record.
  return { actor: { kind: "system", id: "rovara" }, related: [id] };
}

function targetOf(rule: TargetRule, context: MappingContext): AuditTarget | undefined {
  const { event } = context;
  if (typeof rule === "function") return rule(context);
  if ("org" in rule) return { kind: "org", id: event.companyId };
  if ("bySubject" in rule) {
    const inner = event.subject === undefined ? undefined : rule.bySubject[event.subject.type];
    return inner === undefined ? undefined : targetOf(inner, context);
  }
  if (event.subject === undefined) return undefined;
  if ("name" in rule) return event.subject.id === "" ? undefined : { kind: rule.name, name: event.subject.id.slice(0, 200) };
  return { kind: rule.id, id: event.subject.id };
}

/** The facts the mapping names, each through its own value check and then the ledger's (printable ASCII, 128 characters, nothing email-shaped). Nothing else of the core's details is read. */
function factsOf(mapping: EventMapping, context: MappingContext): Record<string, Fact> {
  const facts: Record<string, Fact> = {};
  const allowed = AUDIT_FACT_KEYS[mapping.cloud];
  for (const [key, rule] of Object.entries(mapping.facts ?? {})) {
    if (!allowed.includes(key)) continue;
    const value = factOf(checkedFact(rule, context));
    if (value !== undefined) facts[key] = value;
  }
  return facts;
}

function orgDetailsOf(mapping: EventMapping, context: MappingContext): AuditDetailPart[] {
  const fields: Record<string, string> = {};
  for (const [name, source] of Object.entries(mapping.org ?? {})) {
    const value = valueOf(source, context);
    if (typeof value === "string" && value !== "" && Object.keys(fields).length < AUDIT_DETAIL_FIELDS_MAX) fields[name.slice(0, 64)] = value.slice(0, AUDIT_DETAIL_FIELD_MAX_CHARS);
    else if (typeof value === "number" && Number.isFinite(value) && Object.keys(fields).length < AUDIT_DETAIL_FIELDS_MAX) fields[name.slice(0, 64)] = String(value);
  }
  return Object.keys(fields).length === 0 ? [] : [{ subject: "org", fields }];
}

/** The ledger's event for a core event, or the fixed word saying why there is none. */
export function toCloudAuditEvent(event: AuditEvent, map: Readonly<Record<string, EventMapping>> = CORE_AUDIT_EVENT_MAP): { ok: true; event: AuditEventInput } | { ok: false; refusal: CloudAuditRefusal } {
  const mapping = Object.hasOwn(map, event.action) ? map[event.action] : undefined;
  if (mapping === undefined) return { ok: false, refusal: "unmapped_action" };
  const who = actorOf(event);
  if (who === undefined) return { ok: false, refusal: "bad_actor" };
  const when = Date.parse(event.at);
  if (Number.isNaN(when)) return { ok: false, refusal: "bad_time" };
  const details: JsonObject = event.details ?? {};
  const context: MappingContext = { event, details };
  const target = targetOf(mapping.target, context);
  if (target === undefined) return { ok: false, refusal: "bad_target" };
  const facts = factsOf(mapping, context);
  if ((mapping.required ?? []).some((key) => facts[key] === undefined)) return { ok: false, refusal: "invalid_event" };
  const related = [...who.related, ...(mapping.related?.(context) ?? [])].filter((id): id is string => typeof id === "string" && RELATED_ID.test(id)).slice(0, AUDIT_MAX_RELATED);
  const org = orgDetailsOf(mapping, context);
  // Same core id, same Cloud id: a retry of one occurrence is one record. A core id with a newline (which the ledger's id forbids) is hashed first.
  const occurrence = event.eventId.includes("\n") ? createHash("sha256").update(event.eventId).digest("hex") : event.eventId;
  const candidate: AuditEventInput = {
    eventId: auditEventId(mapping.cloud, `core:${occurrence}`),
    orgId: event.companyId,
    action: mapping.cloud,
    actor: who.actor,
    target,
    occurredAt: new Date(when).toISOString(),
    ...(related.length === 0 ? {} : { related: [...new Set(related)] }),
    ...(Object.keys(facts).length === 0 ? {} : { facts }),
    ...(org.length === 0 ? {} : { details: org }),
  };
  const parsed = AuditEventInputSchema.safeParse(candidate);
  return parsed.success ? { ok: true, event: parsed.data } : { ok: false, refusal: "invalid_event" };
}

export interface CloudAuditSink extends AuditSink {
  /** The one document-store step `stage` returns for an event, or undefined when the event cannot be made. Exposed for tests. */
  rowOf(event: AuditEvent): StoredDocument | undefined;
}

export function createCloudAuditSink(options: CloudAuditSinkOptions): CloudAuditSink {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => undefined);
  const onInvalid = options.onInvalid ?? "refuse";

  function row(event: AuditEvent): StoredDocument | undefined {
    const made = toCloudAuditEvent(event, options.map);
    if (!made.ok) {
      // A code and the core's action name (a fixed word of the core, never a value of this event): nothing else.
      log({ event: "audit.record_invalid", level: "error", reason: made.refusal, coreAction: event.action.slice(0, 64) });
      if (onInvalid === "refuse") throw new CloudAuditSinkError(made.refusal, event.action.slice(0, 64));
      return undefined;
    }
    return JSON.parse(JSON.stringify(auditPendingItem(made.event, now()))) as StoredDocument;
  }

  return {
    rowOf: row,
    stage(event: AuditEvent): readonly TransactItem[] {
      const item = row(event);
      return item === undefined ? [] : [{ kind: "put", item }];
    },
    async record(event: AuditEvent): Promise<void> {
      const item = row(event);
      if (item === undefined) return;
      await options.store().put({ item });
    },
  };
}

/**
 * Whether `staged` (what `stage` returned) still fits in a transaction that already holds `existing`: `steps` when it would pass the store's step limit, `bytes` when it would pass the byte limit, `same_key` when a
 * staged row names a key a step already uses, and undefined when it fits. The core calls `stage` while it builds a transaction and cannot be asked, so this is the check a composition root or a test uses; the
 * store refuses an oversize transaction in any case (`invalid_request`), but only after the caller has built it.
 */
export function auditRoomProblem(existing: readonly TransactItem[], staged: readonly TransactItem[]): "steps" | "bytes" | "same_key" | undefined {
  const keyOf = (item: TransactItem): string => { const key = item.kind === "put" ? item.item : item.key; return `${key.pk}\u0000${key.sk}`; };
  const used = new Set(existing.map(keyOf));
  if (staged.some((item) => used.has(keyOf(item)))) return "same_key";
  if (existing.length + staged.length > DOCUMENT_STORE_LIMITS.maxTransactItems) return "steps";
  const bytes = [...existing, ...staged].reduce((sum, item) => sum + (item.kind === "put" ? Buffer.byteLength(JSON.stringify(item.item)) : 0), 0);
  return bytes > DOCUMENT_STORE_LIMITS.maxTransactBytes ? "bytes" : undefined;
}
