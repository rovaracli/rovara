// The ingest pipeline core (design 4.4.1, "common pipeline"): one function every source tap ends in. The tap has verified the delivery and mapped the actor; this
// function takes a `RecordDraft` and either stores one row or refuses it with a fixed reason. In order:
//   mode (Off captures nothing) -> the scope's source row (enabled, its project, the retention ceiling, the exclude list) -> the edition rule (Public Slack is A or B)
//   -> text hygiene (hidden characters, secrets, personal details, code) -> trust (never above the actor's) -> retention routing -> the strict row schema
//   -> an idempotent write -> the vector (a failure leaves `embedPending`, never loses the row).
// It stores no row for an outside source under retention A or B. It never logs text, a name or an error message.
import {
  OrgIdSchema,
  RecordEventSchema,
  RecordProjectSchema,
  minTrust,
  recordEventKey,
  type OrgId,
  type RecordEvent,
  type RetentionMode,
  type TrustClass,
} from "@agentx/contracts";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Aliases } from "../agents/table-writes.js";
import { captureIsOn, type LearningModeReader } from "./mode.js";
import { exceedsRetention, retentionPlan, retentionRefusal } from "./retention.js";
import { supersedeItem, wasDeletedAtSource } from "./scope-work.js";
import { advanceItemHead, getItemHead, isScopeClosed, versionTimeOf } from "./item-head.js";
import { hasQuotedOrForwarded } from "./quoted.js";
import { isErasedActor } from "./erased.js";
import { deterministicEventId, getSourceConfigByScope, putRecordEvent } from "./store.js";
import { cleanRecordText } from "./text.js";
import type { Edition, IngestOutcome, RecordDraft, RecordEmbedder, RecordLog, RecordVectorPort, TeamRecordTable } from "./types.js";

export interface IngestDependencies {
  table: TeamRecordTable;
  modes: LearningModeReader;
  edition: Edition;
  /** The retention a Rovara-internal row may have when the project has no "Rovara" source row yet: the edition's default (C in Enterprise, D in Public). */
  rovaraDefaultRetention: RetentionMode;
  embedder?: RecordEmbedder;
  vectors?: RecordVectorPort;
  now?: () => number;
  log?: RecordLog;
}

const LINKS_MAX = 20;
const STRUCTURED_MAX = 40;
const STRING_VALUE_MAX = 300;
const ACL_PRINCIPALS_MAX = 500;

/** The fixed reasons a draft can be refused for. */
export type IngestRefusal =
  | "workspace" | "project" | "capture_off" | "no_scope" | "no_source_row" | "source_disabled" | "project_mismatch" | "retention_exceeds_source"
  | "slack_public_fixed_a_b" | "slack_notes_need_opt_in" | "actor_erased" | "scope_closed" | "stale_version" | "excluded" | "retention_not_stored" | "time" | "acl_too_large" | "deleted_at_source" | "invalid";

const refused = (reason: IngestRefusal): IngestOutcome => ({ status: "refused", reason });

function validLink(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** A value a Rovara-trust row may carry: an id, a code or a count, never a sentence a person wrote. */
const ID_SHAPED = /^[\w.:/#-]{1,100}$/;
const STRUCTURED_KEY = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

/**
 * The structured part goes through the same hygiene as text (secrets, personal details, code, hidden characters). On a row of the highest trust a string must be
 * id-shaped: a pull request title written by an outsider cannot ride on `rovara` trust as a structured field.
 */
function cleanStructured(values: RecordDraft["structured"], trust: TrustClass, idOnly: boolean): RecordEvent["structured"] {
  if (values === undefined) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values).slice(0, STRUCTURED_MAX)) {
    if (!STRUCTURED_KEY.test(key)) continue;
    if (typeof value === "string") {
      if (trust === "rovara" || idOnly) {
        if (ID_SHAPED.test(value)) out[key] = value;
        continue;
      }
      const clean = cleanRecordText(value);
      if (clean !== undefined) out[key] = [...clean].slice(0, STRING_VALUE_MAX).join("");
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The scope a draft is stored under: the snapshot's, else the explicit one. */
function draftScope(draft: RecordDraft): string | undefined {
  return draft.audience.kind === "restricted" ? draft.audience.acl.scope : draft.scope;
}

/** What the distiller may use of a retention-B draft once it passed the same checks as a stored row. Nothing here is written to the table. */
export interface AdmittedTransient {
  orgId: OrgId;
  project: string | undefined;
  /** The place the item came from. */
  scope: string;
  /** The lowest trust of the row, its actor, and every quoted or forwarded piece. */
  trust: TrustClass;
  /** The trust of the author's own words (quoted pieces are split off by the distiller's own span rules). */
  baseTrust: TrustClass;
  /** The text after the same hygiene as a stored row. */
  text: string;
  audience: RecordDraft["audience"];
  links: string[];
  occurredAt: string;
  /** An earlier version of this item was replaced: the distiller must clear the notes made from it before it writes the new ones. */
  supersedes?: { rows: Array<{ pk: string; sk: string }>; version: string };
}

export type AdmitOutcome = { admitted: true; item: AdmittedTransient } | { admitted: false; reason: IngestRefusal };

/**
 * Retention B (Public Slack "notes with links"): the text goes to the distiller in memory and no row is stored, but it must pass EVERYTHING a stored row passes first:
 * the mode, the scope's source row and its opt-in, the exclusion list, the erased-person check (an unreadable marker THROWS, so the queue redelivers), the deleted-at-
 * source marker, the trust rules and text hygiene. A refusal means the text is dropped.
 */
export async function admitTransient(deps: IngestDependencies, draft: RecordDraft): Promise<AdmitOutcome> {
  if (draft.retention !== "B" || draft.text === undefined) return { admitted: false, reason: "invalid" };
  const result = await runIngest(deps, draft, true);
  return "admitted" in result ? result : { admitted: false, reason: result.status === "refused" ? (result.reason as IngestRefusal) : "invalid" };
}

export async function ingestRecord(deps: IngestDependencies, draft: RecordDraft): Promise<IngestOutcome> {
  const result = await runIngest(deps, draft, false);
  if ("admitted" in result) return refused("retention_not_stored");
  return result;
}

async function runIngest(deps: IngestDependencies, draft: RecordDraft, admit: boolean): Promise<IngestOutcome | AdmitOutcome> {
  const now = deps.now ?? Date.now;
  const log: RecordLog = deps.log ?? (() => undefined);
  const org = OrgIdSchema.safeParse(draft.workspaceId);
  if (!org.success) return refused("workspace");
  const orgId: OrgId = org.data;
  if (draft.project !== undefined && !RecordProjectSchema.safeParse(draft.project).success) return refused("project");

  // 1. The mode. Off captures nothing. An unreadable mode reads as Off.
  const scope = draftScope(draft);
  let project = draft.project;
  if (!captureIsOn(await deps.modes.effectiveMode(orgId, project))) return refused("capture_off");

  // 2. The scope's source row: enabled, the project it belongs to, and the retention ceiling.
  let ceiling: RetentionMode;
  let excluded: readonly string[] = [];
  let notesOptIn = false;
  if (scope === undefined) {
    if (draft.source !== "rovara") return refused("no_scope");
    ceiling = deps.rovaraDefaultRetention;
  } else {
    const config = await getSourceConfigByScope(deps.table, orgId, draft.source, scope);
    if (config === undefined) {
      if (draft.source !== "rovara") return refused("no_source_row");
      ceiling = deps.rovaraDefaultRetention;
    } else {
      if (!config.enabled) return refused("source_disabled");
      if (project !== undefined && project !== config.project) return refused("project_mismatch");
      project = config.project;
      ceiling = config.retention;
      excluded = config.exclude;
      notesOptIn = config.notesOptIn === true;
    }
  }
  if (exceedsRetention(draft.retention, ceiling)) return refused("retention_exceeds_source");
  const slackRefusal = retentionRefusal(deps.edition, draft.source, draft.retention, notesOptIn);
  if (slackRefusal !== undefined) return refused(slackRefusal);
  // A person who was erased stays erased: a backfill, a poller or an edit cannot bring them back.
  if (draft.actor !== undefined && await isErasedActor(deps.table, orgId, draft.sourceRef.system, draft.actor)) return refused("actor_erased");
  if (draft.actor !== undefined && excluded.includes(draft.actor.sourceId)) return refused("excluded");

  const occurred = new Date(draft.occurredAt);
  if (Number.isNaN(occurred.getTime())) return refused("time");
  const occurredAt = occurred.toISOString();
  if (draft.audience.kind === "restricted" && (draft.audience.acl.principals?.length ?? 0) > ACL_PRINCIPALS_MAX) return refused("acl_too_large");

  // 3. Retention routing. An outside source under A or B stores no row.
  // Trust is the lowest of every piece: the row, its actor, every quoted or forwarded piece, and (no actor on an outside source's text) at most "system".
  const quoted = hasQuotedOrForwarded(draft.text) || draft.hasAttachments === true;
  let trust = minTrust(
    draft.trust,
    ...(draft.actor === undefined ? [] : [draft.actor.trust]),
    ...(draft.pieceTrusts ?? []),
    // Quoted or forwarded words, or attachments, keep their own author's trust; the tap says whose when it knows, otherwise they are an outsider's.
    ...(quoted ? (draft.quotedTrusts ?? ["outsider" as const]) : []),
    ...(draft.actor === undefined && draft.source !== "rovara" && draft.text !== undefined ? ["system" as const] : []),
  );
  // A late edit by someone else never raises what an item was: the lowest trust any version had is kept (the ingest lane's `RecordHistoryPort`).
  const head = await getItemHead(deps.table, orgId, draft.sourceRef.system, draft.sourceRef.id);
  if (head !== undefined) trust = minTrust(trust, head.lowestTrust);
  // The Slack rule follows Slack's words into a Rovara row: in Public they are never kept as text.
  const keptText = deps.edition === "public" && draft.origin === "slack" ? undefined : draft.text;
  const plan = retentionPlan({ retention: draft.retention, source: draft.source, hasText: keptText !== undefined, occurredAtSeconds: Math.floor(occurred.getTime() / 1000), nowSeconds: Math.floor(now() / 1000) });
  if (!plan.store) {
    if (admit && plan.distillTransient) {
      // Everything a stored row would be checked against, except the idempotent write (which a transient draft does not have).
      if (await wasDeletedAtSource(deps.table, orgId, draft.sourceRef.system, draft.sourceRef.id)) return refused("deleted_at_source");
      const clean = cleanRecordText(draft.text);
      const transientScope = scope;
      if (clean === undefined || transientScope === undefined) return refused("invalid");
      if (await isScopeClosed(deps.table, orgId, transientScope)) return refused("scope_closed");
      // Versions are ordered by source time here too, and a newer version clears the notes made from the older one.
      const moved = await advanceItemHead(deps.table, orgId, { system: draft.sourceRef.system, sourceId: draft.sourceRef.id, version: draft.sourceRef.version, versionAt: versionTimeOf(draft), trust, indexExpiresAt: plan.indexExpiresAt });
      if (moved.status === "stale") return refused("stale_version");
      const owedRows = moved.status === "advanced" ? (moved.previous === undefined ? undefined : [moved.previous.row, moved.previous.supersedes?.row]) : moved.owed === undefined ? undefined : [moved.owed.row];
      const baseTrust = minTrust(draft.trust, ...(draft.actor === undefined ? [] : [draft.actor.trust]), ...(draft.actor === undefined && draft.source !== "rovara" ? ["system" as const] : []));
      return { admitted: true, item: { orgId, project, scope: transientScope, trust, baseTrust, text: clean, audience: draft.audience, links: draft.links.filter(validLink).slice(0, LINKS_MAX), occurredAt, ...(owedRows === undefined ? {} : { supersedes: { rows: owedRows.flatMap((row) => (row === undefined ? [] : [row])), version: draft.sourceRef.version } }) } };
    }
    return refused("retention_not_stored");
  }

  // 4. Text hygiene, then the row. A row of rovara trust carries no free text from people.
  const text = plan.keepText && trust !== "rovara" ? cleanRecordText(keptText, { keepCode: draft.kind === "rovara.human_edit" }) : undefined;
  const embed = plan.embed && text !== undefined;
  // Slack words that reached a Rovara row in Public keep no free text anywhere in the row, structured fields included.
  const structured = cleanStructured(draft.structured, trust, deps.edition === "public" && draft.origin === "slack");
  // Every row carries the place it came from. Rovara's own rows without one belong to the project's own place.
  const eventScope = scope ?? (draft.source === "rovara" && project !== undefined ? `rovara:project/${project}` : undefined);
  if (eventScope === undefined) return refused("no_scope");
  const id = deterministicEventId(orgId, draft.source, draft.sourceRef.system, draft.sourceRef.id, draft.sourceRef.version);
  const candidate = {
    id,
    workspaceId: orgId,
    ...(project === undefined ? {} : { project }),
    ...(draft.repo === undefined ? {} : { repo: draft.repo }),
    source: draft.source,
    sourceRef: draft.sourceRef,
    scope: eventScope,
    kind: draft.kind,
    occurredAt,
    ...(draft.actor === undefined ? {} : { actor: draft.actor }),
    trust,
    audience: draft.audience,
    ...(text === undefined ? {} : { text }),
    ...(structured === undefined ? {} : { structured }),
    links: draft.links.filter(validLink).slice(0, LINKS_MAX),
    ...(embed ? { embedPending: true } : {}),
    retention: draft.retention,
    ...(text !== undefined && plan.textExpiresAt !== undefined ? { textExpiresAt: plan.textExpiresAt } : {}),
    hotExpiresAt: plan.hotExpiresAt,
    indexExpiresAt: plan.indexExpiresAt,
  };
  const parsed = RecordEventSchema.safeParse(candidate);
  if (!parsed.success) {
    log("record.ingest_invalid", { source: draft.source, kind: draft.kind });
    return refused("invalid");
  }
  const event = parsed.data;

  // 5. An item deleted at its source stays deleted, and so does a place that was deleted or excluded: a late retry or a backfill is refused.
  if (await wasDeletedAtSource(deps.table, orgId, draft.sourceRef.system, draft.sourceRef.id)) return refused("deleted_at_source");
  if (await isScopeClosed(deps.table, orgId, eventScope)) return refused("scope_closed");

  // 6. Versions are ordered by the source's own time. A version older than the one stored changes nothing (it only lowers the item's remembered trust).
  const versionAt = versionTimeOf(draft);
  const moved = await advanceItemHead(deps.table, orgId, { system: draft.sourceRef.system, sourceId: draft.sourceRef.id, version: draft.sourceRef.version, versionAt, trust, row: recordEventKey(orgId, project, occurredAt, id), indexExpiresAt: plan.indexExpiresAt });
  if (moved.status === "stale") return { status: "duplicate" };

  // 7. The idempotent write; then the older version it replaces (text, vector and notes) is hidden and queued for removal.
  const result = await putRecordEvent(deps.table, event);
  const owed = moved.status === "advanced" ? (moved.previous === undefined ? undefined : [moved.previous.row, moved.previous.supersedes?.row]) : moved.owed === undefined ? undefined : [moved.owed.row];
  if (owed !== undefined) {
    await supersedeItem({ table: deps.table, now }, orgId, { system: draft.sourceRef.system, sourceId: draft.sourceRef.id, version: draft.sourceRef.version, rows: owed.flatMap((row) => (row === undefined || row.sk === recordEventKey(orgId, project, occurredAt, id).sk ? [] : [row])) });
  }
  if (result === "duplicate") return { status: "duplicate" };

  // 8. The vector. A failure leaves the row with `embedPending`, which the nightly retry picks up; it never loses the row or blocks the tap.
  if (embed && deps.embedder !== undefined && deps.vectors !== undefined && text !== undefined) {
    await embedRow(deps, event, text, log);
  }
  return { status: "stored" };
}

export function eventVectorKey(eventId: string): string {
  return `event:${eventId}`;
}

/** The vector's `ref`: the row's id and its time, because a row's key needs both. */
export function eventVectorRef(event: Pick<RecordEvent, "id" | "occurredAt">): string {
  return `${event.id}@${event.occurredAt}`;
}

/** The row a vector's `ref` names, or undefined when it is not one of ours. */
export function parseEventVectorRef(ref: string): { id: string; occurredAt: string } | undefined {
  const match = /^([0-9a-f-]{36})@(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/.exec(ref);
  return match === null ? undefined : { id: match[1] as string, occurredAt: match[2] as string };
}

async function embedRow(deps: IngestDependencies, event: RecordEvent, text: string, log: RecordLog): Promise<void> {
  const embedder = deps.embedder;
  const vectors = deps.vectors;
  if (embedder === undefined || vectors === undefined) return;
  try {
    const vector = await embedder.embed(text, "document");
    const key = eventVectorKey(event.id);
    const result = await vectors.put([{
      key,
      vector,
      metadata: {
        audience_kind: event.audience.kind,
        scope: event.scope.slice(0, 200),
        project: event.project ?? "_workspace",
        trust: event.trust,
        tier: "hot",
        kind: "event",
        ref: eventVectorRef(event),
      },
    }]);
    if (result.failed.length > 0) {
      log("record.embed_pending", { kind: event.kind });
      return;
    }
    const aliases = new Aliases();
    await deps.table.documentClient.send(new UpdateCommand({
      TableName: deps.table.tableName,
      Key: recordEventKey(event.workspaceId, event.project, event.occurredAt, event.id),
      UpdateExpression: `SET ${aliases.name("embeddingRef")} = ${aliases.value(key)} REMOVE ${aliases.name("embedPending")}`,
      ConditionExpression: `attribute_exists(${aliases.name("pk")})`,
      ExpressionAttributeNames: aliases.names,
      ExpressionAttributeValues: aliases.values,
    }));
  } catch {
    // Left embedPending on purpose; the reason is not logged (an embedding error can echo the text).
    log("record.embed_pending", { kind: event.kind });
  }
}
