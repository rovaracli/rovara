// The ingest pipeline core (design 4.4.1, "common pipeline"): one function every source tap ends in. The tap has verified the delivery and mapped the actor; this
// function takes a `RecordDraft` and either stores one row or refuses it with a fixed reason. In order:
//   mode (Off captures nothing) -> the scope's source row (enabled, its project, the retention ceiling, the exclude list) -> the edition rule (Public Slack is A or B)
//   -> text hygiene (hidden characters, secrets, personal details, code) -> trust (never above the actor's) -> retention routing -> the strict row schema
//   -> an idempotent write -> the vector (a failure leaves `embedPending`, never loses the row).
// It stores no row for an outside source under retention A or B. It never logs text, a name or an error message.
import {
  OrgIdSchema,
  agentXError,
  aclUnitOfSource,
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
import { createHash } from "node:crypto";
import { withoutActorFields } from "./person-fields.js";
import { erasedAccessIds, observeOpenRow, observeRowAccess, unitHasList, withoutErasedPrincipals } from "./access.js";
import { captureIsOn, type LearningModeReader } from "./mode.js";
import { exceedsRetention, retentionPlan, retentionRefusal } from "./retention.js";
import { removePrincipalsFromRow, supersedeItem, wasDeletedAtSource } from "./scope-work.js";
import { advanceItemHead, getItemHead, isScopeClosed, versionTimeOf, type AdvanceOutcome } from "./item-head.js";
import { hasQuotedOrForwarded } from "./quoted.js";
import { isErasedActor } from "./erased.js";
import { deleteItem, deterministicEventId, getSourceConfigByScope, putRecordEvent, tombstoneItem } from "./store.js";
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

/**
 * Sources whose ACL belongs to ONE ITEM, not to the place (`RECORD_SOURCE_ACL_UNIT` in the contracts says which): a tracker issue with a security level, a record an MCP server
 * returns with its own list. The access record of such a row is its item's, so one restricted issue never hides the open issues of its project and a newer item's list never
 * replaces another's. The place stays the row's `scope`; only the access unit in the snapshot moves down to the item. A comment shares its issue's unit only when its own list
 * is the issue's; a comment with its own visibility gets a child unit UNDER the issue, so it narrows only itself.
 */
async function accessUnitAudience(deps: IngestDependencies, orgId: OrgId, original: RecordDraft): Promise<RecordDraft["audience"]> {
  // An erased person's id is not stored in a new row's list, whoever wrote the row.
  const draft: RecordDraft = { ...original, audience: await withoutErasedPrincipals(deps.table, orgId, original.audience) };
  if (draft.audience.kind !== "restricted" || aclUnitOfSource(draft.source) !== "item") return draft.audience;
  const hash = (id: string): string => createHash("sha256").update(`${draft.sourceRef.system}\u0000${id}`).digest("hex").slice(0, 24);
  const place = draft.audience.acl.scope;
  if (draft.sourceRef.parentId === undefined) return { kind: "restricted", acl: { ...draft.audience.acl, scope: `${place}/item:${hash(draft.sourceRef.id)}` } };
  const issueUnit = `${place}/item:${hash(draft.sourceRef.parentId)}`;
  // Same list as the issue's (the usual comment): share its unit. A different list, or an issue not recorded yet: a unit of its own under the issue's.
  const shares = await unitHasList(deps.table, orgId, issueUnit, draft.audience.acl);
  return { kind: "restricted", acl: { ...draft.audience.acl, scope: shares ? issueUnit : `${issueUnit}/c:${hash(draft.sourceRef.id)}` } };
}

/** What the distiller may use of a retention-B draft once it passed the same checks as a stored row. Nothing here is written to the table. */
export interface AdmittedTransient {
  orgId: OrgId;
  project: string | undefined;
  /** The place the item came from. */
  scope: string;
  /** The lowest trust of the row, its actor, and every quoted or forwarded piece. */
  trust: TrustClass;
  /** The trust of the author's own words: the row's trust without the quote terms (the tap's piece trusts and the item's history included). Quoted pieces are split off span by span. */
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
  // Rovara's own events: the project's `rovara:project/<p>` row decides, also for a private task's event (its access snapshot names the task's place, which has no row of its own).
  const rowScope = draft.source === "rovara" && project !== undefined ? `rovara:project/${project}` : scope;
  if (rowScope === undefined) {
    if (draft.source !== "rovara") return refused("no_scope");
    ceiling = deps.rovaraDefaultRetention;
  } else {
    const config = await getSourceConfigByScope(deps.table, orgId, draft.source, rowScope);
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
    ...(quoted ? (draft.quotedTrusts !== undefined && draft.quotedTrusts.length > 0 ? draft.quotedTrusts : ["outsider" as const]) : []),
    ...(draft.actor === undefined && draft.source !== "rovara" && draft.text !== undefined ? ["system" as const] : []),
  );
  // A late edit by someone else never raises what an item was: the lowest trust any version had is kept (the ingest lane's `RecordHistoryPort`).
  // A per-editor change row (`sourceRef.order`) holds only its own editor's words, so no earlier version's trust applies to it and no earlier row is replaced by it.
  const change = draft.sourceRef.order !== undefined;
  const head = change ? undefined : await getItemHead(deps.table, orgId, draft.sourceRef.system, draft.sourceRef.id);
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
      const moved: AdvanceOutcome = change ? { status: "advanced", lowestTrust: trust, previous: undefined } : await advanceItemHead(deps.table, orgId, { system: draft.sourceRef.system, sourceId: draft.sourceRef.id, version: draft.sourceRef.version, versionAt: versionTimeOf(draft), trust, indexExpiresAt: plan.indexExpiresAt, scope: transientScope });
      if (moved.status === "stale") return refused("stale_version");
      const owedRows = moved.status === "advanced" ? (moved.previous === undefined ? undefined : [moved.previous.row, moved.previous.supersedes?.row]) : moved.owed === undefined ? undefined : [moved.owed.row];
      // The trust of the author's OWN words: every reason the row was lowered except the quote terms (those are applied span by span, where the splitter finds the quote). The tap's
      // piece trusts and the item's history lower the own words too.
      const baseTrust = minTrust(draft.trust, ...(draft.actor === undefined ? [] : [draft.actor.trust]), ...(draft.pieceTrusts ?? []), ...(head === undefined ? [] : [head.lowestTrust]), ...(draft.actor === undefined && draft.source !== "rovara" ? ["system" as const] : []));
      return { admitted: true, item: { orgId, project, scope: transientScope, trust, baseTrust, text: clean, audience: await accessUnitAudience(deps, orgId, draft), links: draft.links.filter(validLink).slice(0, LINKS_MAX), occurredAt, ...(owedRows === undefined ? {} : { supersedes: { rows: owedRows.flatMap((row) => (row === undefined ? [] : [row])), version: draft.sourceRef.version } }) } };
    }
    return refused("retention_not_stored");
  }

  // 4. Text hygiene, then the row. A row of rovara trust carries no free text from people.
  const text = plan.keepText && trust !== "rovara" ? cleanRecordText(keptText, { keepCode: draft.kind === "rovara.human_edit" }) : undefined;
  const embed = plan.embed && text !== undefined;
  // Slack words that reached a Rovara row in Public keep no free text anywhere in the row, structured fields included.
  // No actor id rides in a structured field (`ACTOR_STRUCTURED_FIELDS`): a row is found for an erase by its actor only.
  const structured = withoutActorFields(cleanStructured(draft.structured, trust, deps.edition === "public" && draft.origin === "slack"));
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
    audience: await accessUnitAudience(deps, orgId, draft),
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
  // The place's access record exists before the first restricted row is readable (reads drop a restricted row whose place has none). A newer snapshot replaces the list only
  // while no member or audience event has reached the record.
  if (event.audience.kind === "restricted") await observeRowAccess(deps.table, orgId, event.audience.acl);
  else await observeOpenRow(deps.table, orgId, eventScope, occurredAt);

  // 6. Versions are ordered by the source's own time. A version older than the one stored changes nothing (it only lowers the item's remembered trust).
  const versionAt = versionTimeOf(draft);
  const moved: AdvanceOutcome = change ? { status: "advanced", lowestTrust: trust, previous: undefined } : await advanceItemHead(deps.table, orgId, { system: draft.sourceRef.system, sourceId: draft.sourceRef.id, version: draft.sourceRef.version, versionAt, trust, row: recordEventKey(orgId, project, occurredAt, id), indexExpiresAt: plan.indexExpiresAt, scope: eventScope });
  if (moved.status === "stale") return { status: "duplicate" };

  // 7. The idempotent write; then the older version it replaces (text, vector and notes) is hidden and queued for removal. If this version's row was already there
  // (a redelivery of a version that is now the head again), nothing is replaced: there is nothing newer to make way for.
  const result = await putRecordEvent(deps.table, event);
  // 7a. The erase race (TR-E1): the markers were read BEFORE the row was written (twice: here and in the access record), and an erase can finish in between, so a row can be stored
  // naming a person who is erased by now, with no index item for the erase's passes to find it by. The markers are read once more AFTER the write. Either the erase's marker was
  // written before this read (seen here, and the id is taken out of the stored row), or after it, and then the row and the access index it was written with already existed when the
  // erase ran (both are written before the row), so the erase finds the place. A stored row is checked against the list it was built from; a redelivery that finds the row already
  // there is checked against the draft's own list, so a repair that failed once is made on the retry.
  // The ACTOR is checked again too: the check at the top of this function can be stale by the time the row lands (even past the erase's delayed second pass), and a row of an erased
  // actor must not wait for any pass to be found. It is hidden and removed here, and the draft is refused.
  const key = recordEventKey(orgId, project, occurredAt, id);
  if (draft.actor !== undefined && await isErasedActor(deps.table, orgId, draft.sourceRef.system, draft.actor)) {
    await dropRowOfErasedActor(deps, key, id);
    return refused("actor_erased");
  }
  await removeErasedFromStoredRow(deps, orgId, key, result === "stored" ? principalsOf(event.audience) : principalsOf(draft.audience));
  const owed = moved.status === "advanced" ? (moved.previous === undefined || result === "duplicate" ? undefined : [moved.previous.row, moved.previous.supersedes?.row]) : moved.owed === undefined ? undefined : [moved.owed.row];
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

const principalsOf = (audience: RecordDraft["audience"]): readonly string[] => (audience.kind === "restricted" ? audience.acl.principals ?? [] : []);

/** Throws when the row still names an erased person afterwards, so the queue redelivers the draft (an unreadable marker throws too). */
async function removeErasedFromStoredRow(deps: IngestDependencies, orgId: OrgId, key: { pk: string; sk: string }, principals: readonly string[]): Promise<void> {
  if (principals.length === 0) return;
  const erased = await erasedAccessIds(deps.table, orgId, principals);
  if (erased.size === 0) return;
  const cleaned = await removePrincipalsFromRow(deps.table, key, erased).catch(() => false);
  if (cleaned) return;
  // Fail closed: a row that could not be cleaned is hidden (and its text dropped) BEFORE the failure is reported, so a caller that swallows the error never keeps a dirty row readable.
  await tombstoneItem(deps.table, key, { at: new Date((deps.now ?? Date.now)()).toISOString(), cause: "person_erased" }).catch(() => false);
  throw agentXError("RUNTIME_UNAVAILABLE", "A row that names an erased person could not be cleaned right now.");
}

/** Hides, then removes, a row whose actor was erased while it was being written. Its vector (a redelivery after the embed) goes first; a vector that cannot be deleted keeps the hidden row and fails the put. */
async function dropRowOfErasedActor(deps: IngestDependencies, key: { pk: string; sk: string }, id: string): Promise<void> {
  await tombstoneItem(deps.table, key, { at: new Date((deps.now ?? Date.now)()).toISOString(), cause: "person_erased" });
  if (deps.vectors !== undefined) {
    const deleted = await deps.vectors.delete([eventVectorKey(id)]).catch(() => undefined);
    if (deleted === undefined || deleted.failed.length > 0) throw agentXError("RUNTIME_UNAVAILABLE", "The vector of an erased person's row could not be deleted right now.");
  }
  await deleteItem(deps.table, key);
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
