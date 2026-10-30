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
} from "@agentx/contracts";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Aliases } from "../agents/table-writes.js";
import { captureIsOn, type LearningModeReader } from "./mode.js";
import { exceedsRetention, retentionPlan, retentionRefusal } from "./retention.js";
import { wasDeletedAtSource } from "./scope-work.js";
import { deterministicEventId, getSourceConfigByScope, putRecordEvent, scopeOfEvent } from "./store.js";
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
  | "slack_public_fixed_a_b" | "excluded" | "retention_not_stored" | "time" | "acl_too_large" | "deleted_at_source" | "invalid";

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

function cleanStructured(values: RecordDraft["structured"]): RecordEvent["structured"] {
  if (values === undefined) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values).slice(0, STRUCTURED_MAX)) {
    if (key.length === 0 || key.length > 60) continue;
    if (typeof value === "string") out[key] = [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ")].slice(0, STRING_VALUE_MAX).join("");
    else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The scope a draft is stored under: the snapshot's, else the explicit one. */
function draftScope(draft: RecordDraft): string | undefined {
  return draft.audience.kind === "restricted" ? draft.audience.acl.scope : draft.scope;
}

export async function ingestRecord(deps: IngestDependencies, draft: RecordDraft): Promise<IngestOutcome> {
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
    }
  }
  if (exceedsRetention(draft.retention, ceiling)) return refused("retention_exceeds_source");
  if (retentionRefusal(deps.edition, draft.source, draft.retention) !== undefined) return refused("slack_public_fixed_a_b");
  if (draft.actor !== undefined && excluded.includes(draft.actor.sourceId)) return refused("excluded");

  const occurred = new Date(draft.occurredAt);
  if (Number.isNaN(occurred.getTime())) return refused("time");
  const occurredAt = occurred.toISOString();
  if (draft.audience.kind === "restricted" && (draft.audience.acl.principals?.length ?? 0) > ACL_PRINCIPALS_MAX) return refused("acl_too_large");

  // 3. Retention routing. An outside source under A or B stores no row.
  const trust = minTrust(draft.trust, ...(draft.actor === undefined ? [] : [draft.actor.trust]));
  const plan = retentionPlan({ retention: draft.retention, source: draft.source, hasText: draft.text !== undefined, occurredAtSeconds: Math.floor(occurred.getTime() / 1000), nowSeconds: Math.floor(now() / 1000) });
  if (!plan.store) return refused("retention_not_stored");

  // 4. Text hygiene, then the row. A row of rovara trust carries no free text from people.
  const text = plan.keepText && trust !== "rovara" ? cleanRecordText(draft.text, { keepCode: draft.kind === "rovara.human_edit" }) : undefined;
  const embed = plan.embed && text !== undefined;
  const structured = cleanStructured(draft.structured);
  const id = deterministicEventId(orgId, draft.source, draft.sourceRef.system, draft.sourceRef.id, draft.sourceRef.version);
  const candidate = {
    id,
    workspaceId: orgId,
    ...(project === undefined ? {} : { project }),
    ...(draft.repo === undefined ? {} : { repo: draft.repo }),
    source: draft.source,
    sourceRef: draft.sourceRef,
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

  // 5. An item deleted at its source stays deleted: a late retry of its create is refused.
  if (await wasDeletedAtSource(deps.table, orgId, draft.sourceRef.system, draft.sourceRef.id)) return refused("deleted_at_source");

  // 6. The idempotent write.
  const result = await putRecordEvent(deps.table, event, scope);
  if (result === "duplicate") return { status: "duplicate" };

  // 7. The vector. A failure leaves the row with `embedPending`, which the nightly retry picks up; it never loses the row or blocks the tap.
  if (embed && deps.embedder !== undefined && deps.vectors !== undefined && text !== undefined) {
    await embedRow(deps, event, text, scopeOfEvent(event, scope), log);
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

async function embedRow(deps: IngestDependencies, event: RecordEvent, text: string, scope: string | undefined, log: RecordLog): Promise<void> {
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
        scope: (scope ?? `project:${event.project ?? "_workspace"}`).slice(0, 200),
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
