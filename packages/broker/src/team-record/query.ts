// The query API of the Team record (design 4.10, task R9): the one place anything reads the record for a person or for a task's model context.
//   recordSearch  search rows and facts, by meaning when a vector index is there and by keyword over the newest rows when it is not
//   pastWork      the Plan 9 `past_work` contract: earlier tasks, with the outcome and what was learned
//   recordFacts   the distilled notes, newest first
//   recordStats   a fixed statistics template over the lake, never caller SQL
// The workspace always comes from the audience (the caller's org), never from a request. Every hit is checked in the broker by the permission filter before it is
// shown (`filterVisible`): a vector filter upstream is only a coarse cut. A reply carries a count of hits the caller may not see, never the hits. Mode Off answers
// nothing. A person who is not in the project is refused. Each call counts against a per-person (or per-task) hourly limit.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  PAST_WORK_LIMIT_MAX,
  PAST_WORK_PLAN_SUMMARY_MAX,
  PastWorkResponseSchema,
  RECORD_FACTS_LIMIT_MAX,
  RECORD_SEARCH_LIMIT_MAX,
  RECORD_SNIPPET_MAX,
  RecordFactsResponseSchema,
  RecordSearchResponseSchema,
  STATS_TEMPLATES,
  agentXError,
  redactText,
  teamRecordPk,
  type Audience,
  type OrgId,
  type PastWorkItem,
  type PastWorkResponse,
  type RecordFact,
  type RecordFactsResponse,
  type RecordSearchHit,
  type RecordSearchQuery,
  type RecordSearchResponse,
  type StatsTemplate,
  type TrustClass,
} from "@agentx/contracts";
import { Aliases, errorName } from "../agents/table-writes.js";
import { filterVisible, type FilterDependencies, type FilterResult, type LiveCheckCache } from "./acl.js";
import { parseEventVectorRef } from "./ingest.js";
import type { LearningModeReader } from "./mode.js";
import { getRecordEvent, getRecordFact, hiddenScopesOf, queryRecordEvents, queryRecordFacts, type StoredEvent } from "./store.js";
import type { LiveAclCheck, ReadAudience, RecordEmbedder, RecordLog, TeamRecordTable } from "./types.js";

export const RECORD_QUERIES_PER_PERSON_PER_HOUR = 120;
export const RECORD_QUERIES_PER_TASK_PER_HOUR = 60;
/** The newest rows a keyword search reads when there is no vector index (a bounded scan of the hot layer). */
export const KEYWORD_SCAN_ROWS = 400;
const VECTOR_OVERFETCH = 3;
const FACT_SCAN = 200;
const PAST_WORK_EVENT_SCAN = 400;

/** The vector index's query side. Mirrors the storage lane's `VectorIndex.query`. */
export interface RecordVectorSearchPort {
  query(request: { vector: number[]; topK: number; filter: { project: string; audienceKinds?: Array<"project" | "restricted"> } }): Promise<Array<{ key: string; distance: number; metadata: { ref: string; kind: string; project: string; trust: TrustClass; audience_kind: "project" | "restricted"; scope: string } }>>;
}

/** Counts a call against an hour's limit. Returns false when the limit is reached. A throw is read as "limit reached" (fail closed). */
export interface RateLimiter {
  take(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

/** A task that earlier ran, as the task records and sessions know it (Plan 9). The record adds the outcome and what was learned. */
export interface PastWorkTask {
  taskId: string;
  title: string;
  status: string;
  link?: string;
  pullRequests: string[];
  planSummary: string;
  /** Who may see the task itself: its Plan 5 visibility as an audience. */
  audience: Audience;
}
export interface PastWorkTasksPort {
  search(input: { orgId: OrgId; project: string; query: string; limit: number }): Promise<PastWorkTask[]>;
}

export interface StatsPort {
  /** Runs a fixed template over the lake. `workspaceId` and `project` are bound by the runner; the caller's text never reaches SQL. Rows are scalars. */
  run(input: { template: StatsTemplate; workspaceId: OrgId; project: string; params: Record<string, string | number> }): Promise<Array<Record<string, string | number | null>>>;
}

export interface RecordQueryDependencies {
  table: TeamRecordTable;
  modes: LearningModeReader;
  embedder?: RecordEmbedder;
  vectorSearch?: RecordVectorSearchPort;
  liveCheck?: LiveAclCheck;
  liveCache?: LiveCheckCache;
  limiter?: RateLimiter;
  tasks?: PastWorkTasksPort;
  lessonsOfTask?(orgId: OrgId, project: string, taskId: string): Promise<string[]>;
  stats?: StatsPort;
  now?: () => number;
  log?: RecordLog;
}

export interface QueryOptions {
  /** What the hourly limit counts: a person by default, or a task's own key for an agent. */
  rateKey?: string;
  rateLimit?: number;
}

export const orgOfAudience = (audience: ReadAudience): OrgId => (audience.kind === "shared" ? audience.orgId : audience.caller.orgId);

async function guard(deps: RecordQueryDependencies, audience: ReadAudience, project: string, options: QueryOptions, what: string): Promise<"ok" | "off"> {
  if (audience.kind === "caller" && audience.caller.projectRole === undefined) throw agentXError("PROJECT_ACCESS_DENIED", `You don't have access to ${project}.`);
  // Off (or an unreadable mode) answers nothing: the record is not offered while learning is off.
  if ((await deps.modes.effectiveMode(orgOfAudience(audience), project)) === "off") return "off";
  if (deps.limiter !== undefined) {
    const key = options.rateKey ?? (audience.kind === "caller" ? `person:${audience.caller.developerId}` : `shared:${project}`);
    const limit = options.rateLimit ?? (audience.kind === "caller" ? RECORD_QUERIES_PER_PERSON_PER_HOUR : RECORD_QUERIES_PER_TASK_PER_HOUR);
    const allowed = await deps.limiter.take(`${orgOfAudience(audience)}|${what}|${key}`, limit, 3_600).then((value) => value, () => false);
    if (!allowed) throw agentXError("TOO_MANY_REQUESTS", "Too many record searches this hour. Try again later.");
  }
  return "ok";
}

async function filterDependencies(deps: RecordQueryDependencies, orgId: OrgId): Promise<FilterDependencies> {
  const hiddenScopes = await hiddenScopesOf(deps.table, orgId).catch(() => undefined);
  if (hiddenScopes === undefined) {
    // Work on a scope that cannot be listed leaves nothing safe to show from a restricted source: only project-wide rows are shown by the caller's retry.
    throw agentXError("RUNTIME_UNAVAILABLE", "The team record can't be read right now.");
  }
  return { ...(deps.liveCheck === undefined ? {} : { liveCheck: deps.liveCheck }), ...(deps.liveCache === undefined ? {} : { cache: deps.liveCache }), ...(deps.now === undefined ? {} : { now: deps.now }), hiddenScopes };
}

const KIND_TITLES: Record<string, string> = {
  "slack.message": "Slack message", "ticket.created": "Ticket created", "ticket.updated": "Ticket updated", "ticket.comment": "Ticket comment", "github.pr": "Pull request",
  "github.review": "Review", "github.review_comment": "Review comment", "github.ci": "CI result", "github.revert": "Revert", "rovara.task": "Rovara task", "rovara.plan": "Rovara plan",
  "rovara.send_back": "Send-back", "rovara.review": "Rovara review", "rovara.human_edit": "Human edit", "rovara.merged": "Merged", "rovara.closed": "Closed", "rovara.remembered": "Remembered note",
  "rovara.ask": "Question to Rovara", fact: "Team note",
};

const snippet = (text: string | undefined): string => redactText([...(text ?? "")].slice(0, RECORD_SNIPPET_MAX).join(""));

function hitOfEvent(event: StoredEvent): RecordSearchHit {
  const structuredTitle = typeof event.structured?.title === "string" ? event.structured.title : undefined;
  return {
    id: event.id, kind: event.kind, source: event.source, occurredAt: event.occurredAt,
    title: (structuredTitle ?? KIND_TITLES[event.kind] ?? event.kind).slice(0, 200), snippet: snippet(event.text), ...(event.links[0] === undefined ? {} : { link: event.links[0] }),
    trust: event.trust, audienceKind: event.audience.kind,
  };
}

function hitOfFact(fact: RecordFact): RecordSearchHit {
  return {
    id: fact.id, kind: "fact", source: "rovara", occurredAt: fact.createdAt, title: KIND_TITLES.fact ?? "Team note", snippet: snippet(fact.text), ...(fact.links[0] === undefined ? {} : { link: fact.links[0] }),
    trust: fact.trust, audienceKind: fact.audience.kind,
  };
}

const words = (query: string): string[] => query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2).slice(0, 12);
function matches(query: string, haystack: string): number {
  const needles = words(query);
  if (needles.length === 0) return 0;
  const lower = haystack.toLowerCase();
  return needles.filter((word) => lower.includes(word)).length / needles.length;
}

/** Search rows and facts. By meaning when the index and the embedder are there; if they fail, or are not there, by keyword over the newest rows. */
export async function recordSearch(deps: RecordQueryDependencies, audience: ReadAudience, project: string, request: Omit<RecordSearchQuery, "limit"> & { limit?: number }, options: QueryOptions = {}): Promise<RecordSearchResponse> {
  const limit = Math.min(request.limit ?? 10, RECORD_SEARCH_LIMIT_MAX);
  if ((await guard(deps, audience, project, options, "search")) === "off") return { hits: [], withheld: 0 };
  const orgId = orgOfAudience(audience);
  const filters = await filterDependencies(deps, orgId);
  const since = request.since === undefined ? undefined : Date.parse(request.since);
  const until = request.until === undefined ? undefined : Date.parse(request.until);
  const inWindow = (at: string): boolean => (since === undefined || Date.parse(at) >= since) && (until === undefined || Date.parse(at) <= until);

  type Candidate = { score: number; event?: StoredEvent; fact?: RecordFact };
  let candidates: Candidate[] | undefined;
  if (deps.embedder !== undefined && deps.vectorSearch !== undefined) {
    try {
      const vector = await deps.embedder.embed(request.query, "query");
      const ranked = await deps.vectorSearch.query({
        vector, topK: limit * VECTOR_OVERFETCH,
        filter: { project, ...(audience.kind === "shared" ? { audienceKinds: ["project" as const] } : {}) },
      });
      candidates = [];
      for (const hit of ranked) {
        if (hit.metadata.project !== project) continue;
        const score = 1 - hit.distance;
        if (hit.key.startsWith("event:")) {
          const ref = parseEventVectorRef(hit.metadata.ref);
          if (ref === undefined) continue;
          const event = await getRecordEvent(deps.table, orgId, project, ref.occurredAt, ref.id);
          if (event !== undefined) candidates.push({ score, event });
        } else if (hit.key.startsWith("fact:")) {
          const fact = await getRecordFact(deps.table, orgId, project, hit.key.slice("fact:".length));
          if (fact !== undefined) candidates.push({ score, fact });
        }
      }
    } catch {
      deps.log?.("record.search_vector_failed", {});
      candidates = undefined;
    }
  }
  if (candidates === undefined) {
    // Keyword over the newest hot rows and the facts (design 4.11: the embedding or the index is unavailable).
    candidates = [];
    for (const event of await queryRecordEvents(deps.table, orgId, project, { limit: KEYWORD_SCAN_ROWS })) {
      const score = matches(request.query, `${event.text ?? ""} ${JSON.stringify(event.structured ?? {})}`);
      if (score > 0) candidates.push({ score, event });
    }
    for (const fact of await queryRecordFacts(deps.table, orgId, project, FACT_SCAN)) {
      const score = matches(request.query, fact.text);
      if (score > 0) candidates.push({ score, fact });
    }
  }

  const wanted = candidates
    .filter((candidate) => {
      if (candidate.event !== undefined) {
        return candidate.event.workspaceId === orgId && inWindow(candidate.event.occurredAt) && (request.kinds === undefined || request.kinds.includes(candidate.event.kind))
          && (request.sources === undefined || request.sources.includes(candidate.event.source));
      }
      return candidate.fact !== undefined && candidate.fact.workspaceId === orgId && inWindow(candidate.fact.createdAt) && request.kinds === undefined && request.sources === undefined;
    })
    .sort((left, right) => right.score - left.score);

  const checkedEvents = await filterVisible(wanted.flatMap((candidate) => (candidate.event === undefined ? [] : [candidate.event])), audience, filters);
  const checkedFacts = await filterVisible(wanted.flatMap((candidate) => (candidate.fact === undefined ? [] : [candidate.fact])), audience, filters);
  const okEvents = new Set(checkedEvents.visible);
  const okFacts = new Set(checkedFacts.visible);
  const hits: RecordSearchHit[] = [];
  for (const candidate of wanted) {
    if (hits.length >= limit) break;
    if (candidate.event !== undefined && okEvents.has(candidate.event)) hits.push(hitOfEvent(candidate.event));
    else if (candidate.fact !== undefined && okFacts.has(candidate.fact)) hits.push(hitOfFact(candidate.fact));
  }
  return RecordSearchResponseSchema.parse({ hits, withheld: checkedEvents.withheld + checkedFacts.withheld });
}

/** The distilled notes of a project the audience may see, newest first. */
export async function recordFacts(deps: RecordQueryDependencies, audience: ReadAudience, project: string, request: { kinds?: Array<RecordFact["kind"]> | undefined; since?: string | undefined; limit?: number | undefined }, options: QueryOptions = {}): Promise<RecordFactsResponse> {
  const limit = Math.min(request.limit ?? 20, RECORD_FACTS_LIMIT_MAX);
  if ((await guard(deps, audience, project, options, "facts")) === "off") return { facts: [], withheld: 0 };
  const orgId = orgOfAudience(audience);
  const since = request.since === undefined ? undefined : Date.parse(request.since);
  const all = (await queryRecordFacts(deps.table, orgId, project, FACT_SCAN))
    .filter((fact) => fact.workspaceId === orgId && (request.kinds === undefined || request.kinds.includes(fact.kind)) && (since === undefined || Date.parse(fact.createdAt) >= since))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const checked: FilterResult<RecordFact> = await filterVisible(all, audience, await filterDependencies(deps, orgId));
  return RecordFactsResponseSchema.parse({ facts: checked.visible.slice(0, limit), withheld: checked.withheld });
}

const OUTCOME_KINDS = new Set(["rovara.task", "rovara.send_back", "rovara.closed", "rovara.merged", "github.revert"]);

/**
 * The Plan 9 `past_work` contract on the Team record. `shared` returns only tasks every project member can view; `private` returns what the asker can view. The
 * outcome (merged, send-backs, reverted) comes from the record's own rows for the task, and what was learned from the lessons port.
 */
export async function pastWork(deps: RecordQueryDependencies, audience: ReadAudience, audienceMode: "shared" | "private", project: string, request: { query: string; limit?: number }, options: QueryOptions = {}): Promise<PastWorkResponse> {
  const limit = Math.min(request.limit ?? 5, PAST_WORK_LIMIT_MAX);
  // `shared` is the agent's default: whatever the caller is, only what the whole project may view. `private` needs a person.
  if (audienceMode === "private" && audience.kind !== "caller") throw agentXError("FORBIDDEN", "A private search needs a person.");
  const effective: ReadAudience = audienceMode === "shared" ? { kind: "shared", orgId: orgOfAudience(audience) } : audience;
  if ((await guard(deps, audience, project, options, "past_work")) === "off") return { items: [], withheld: 0 };
  if (deps.tasks === undefined) return { items: [], withheld: 0 };
  const orgId = orgOfAudience(audience);
  const found = await deps.tasks.search({ orgId, project, query: request.query, limit: limit * 3 });
  const checked = await filterVisible(found.map((task) => ({ ...task, audience: task.audience })), effective, await filterDependencies(deps, orgId));

  const outcomes = new Map<string, { merged: boolean; sendBacks: number; reverted: boolean }>();
  for (const event of await queryRecordEvents(deps.table, orgId, project, { limit: PAST_WORK_EVENT_SCAN })) {
    if (event.tombstone !== undefined || !OUTCOME_KINDS.has(event.kind)) continue;
    const taskId = event.structured?.taskId;
    if (typeof taskId !== "string") continue;
    const entry = outcomes.get(taskId) ?? { merged: false, sendBacks: 0, reverted: false };
    if (event.kind === "rovara.send_back") entry.sendBacks += 1;
    else if (event.kind === "rovara.merged") entry.merged = true;
    else if (event.kind === "github.revert") entry.reverted = true;
    else if (event.structured?.outcome === "merged") entry.merged = true;
    else if (event.structured?.outcome === "reverted") entry.reverted = true;
    outcomes.set(taskId, entry);
  }
  const items: PastWorkItem[] = [];
  for (const task of checked.visible.slice(0, limit)) {
    const lessons = await (deps.lessonsOfTask?.(orgId, project, task.taskId) ?? Promise.resolve<string[]>([])).then((titles) => titles.slice(0, 10).map((title) => title.slice(0, 160)), () => [] as string[]);
    items.push({
      taskId: task.taskId, title: redactText(task.title).slice(0, 200), status: task.status.slice(0, 40), ...(task.link === undefined ? {} : { link: task.link }), pullRequests: task.pullRequests.slice(0, 10),
      planSummary: redactText(task.planSummary).slice(0, PAST_WORK_PLAN_SUMMARY_MAX),
      outcome: outcomes.get(task.taskId) ?? { merged: false, sendBacks: 0, reverted: false }, lessonsLearned: lessons,
    });
  }
  return PastWorkResponseSchema.parse({ items, withheld: checked.withheld });
}

export type StatsAnswer = { status: "ok"; rows: Array<Record<string, string | number | null>> } | { status: "unavailable"; text: string };

/** A fixed statistics template over the lake for a project. Only a member with a project role may ask; counts cover project-wide rows only, so a private source never shows through a total. */
export async function recordStats(deps: RecordQueryDependencies, audience: ReadAudience, project: string, request: { template: string; params?: Record<string, string | number> }, options: QueryOptions = {}): Promise<StatsAnswer> {
  if (audience.kind !== "caller") throw agentXError("FORBIDDEN", "Statistics are for people, not for a task.");
  if (!(STATS_TEMPLATES as readonly string[]).includes(request.template)) throw agentXError("CONFIG_INVALID", "That statistics template does not exist.");
  if ((await guard(deps, audience, project, options, "stats")) === "off") return { status: "ok", rows: [] };
  if (deps.stats === undefined) return { status: "unavailable", text: "History is unavailable right now." };
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(request.params ?? {}).slice(0, 8)) {
    if (!/^[a-z][a-zA-Z0-9]{0,30}$/.test(key)) throw agentXError("CONFIG_INVALID", "A statistics parameter has an invalid name.");
    if (typeof value === "number" ? !Number.isFinite(value) : typeof value !== "string" || value.length > 100) throw agentXError("CONFIG_INVALID", "A statistics parameter has an invalid value.");
    params[key] = value;
  }
  try {
    const rows = await deps.stats.run({ template: request.template as StatsTemplate, workspaceId: audience.caller.orgId, project, params });
    return { status: "ok", rows: rows.slice(0, 200) };
  } catch {
    deps.log?.("record.stats_unavailable", { template: request.template });
    return { status: "unavailable", text: "History is unavailable right now." };
  }
}

// ---- the hourly limit

/** A fixed hourly window per key in the TeamRecord table: `ADD` one while below the limit. The item expires a few hours later. */
export function dynamoRateLimiter(table: TeamRecordTable, now: () => number = Date.now): RateLimiter {
  return {
    async take(key, limit, windowSeconds) {
      const window = Math.floor(now() / 1000 / windowSeconds);
      const aliases = new Aliases();
      const orgId = /^(org_[0-9a-z]{20})\|/.exec(key)?.[1];
      if (orgId === undefined) return false;
      try {
        await table.documentClient.send(new UpdateCommand({
          TableName: table.tableName,
          Key: { pk: teamRecordPk(orgId), sk: `RATE#${key.slice(orgId.length + 1)}#${String(window)}` },
          UpdateExpression: `ADD ${aliases.name("count")} ${aliases.value(1)} SET ${aliases.name("indexExpiresAt")} = ${aliases.value((window + 3) * windowSeconds)}`,
          ConditionExpression: `attribute_not_exists(${aliases.name("count")}) OR ${aliases.name("count")} < ${aliases.value(limit)}`,
          ExpressionAttributeNames: aliases.names,
          ExpressionAttributeValues: aliases.values,
        }));
        return true;
      } catch (error) {
        if (errorName(error) === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
  };
}

