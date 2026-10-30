// v1.2 learning loop: the store for a project's learning partition (design §3). New logic of B1; B3 to B8 write through it.
//
// What it guarantees:
// - Retention: corrections, their source records and dismissed patterns expire 180 days after capture (`indexExpiresAt`); a suggestion gets the same expiry when it ends, and loses
//   `proposedText` and `dismissNote` in that same transaction. Reads treat an expired item as absent; nothing here deletes on read (the TTL and sweep.ts delete).
// - A project created again under the same name sees nothing of the earlier one (`projectCreatedAt`), and its first write starts a fresh STATE.
// - Caps: 20 suggestions that are not terminal, 2,000 live corrections, 100 automatic captures a day of which 50 PR comments, 30 Remember per person per 10 minutes. Each is a
//   condition of the same transaction that writes the item, so two racing writers cannot both pass.
// - Reads of a whole partition page with a budget and a resume cursor, so the company-wide jobs (walk.ts) can use them.
//
// Counters on STATE move with `ADD` and do not change `revision`; `revision` moves when a suggestion opens, which is what grouping serializes on.
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE, LEARNING_DAILY_AUTOMATIC_MAX, LEARNING_DAILY_PR_MAX, LEARNING_LIVE_CORRECTIONS_MAX, LEARNING_OPEN_SUGGESTIONS_MAX, LEARNING_REMEMBER_MAX,
  LEARNING_REMEMBER_WINDOW_SECONDS, LearningCorrectionSchema, LearningStateSchema, LearningSuggestionSchema, LEARNING_TERMINAL_STATUSES, agentXError, projectLearningKey,
  type LearningCorrection, type LearningCorrectionSource, type LearningDismissKindSchema, type LearningSourceRef, type LearningStage, type LearningStanding, type LearningState,
  type LearningSuggestion, type LearningTerminalStatus, type OrgId,
} from "@agentx/contracts";
import type { z } from "zod";
import { learningExpiry, sameProject, shortLearningExpiry, visibility } from "./retention.js";

type Item = Record<string, unknown>;
type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

export interface LearningDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The clock, in epoch milliseconds. */
  now: () => number;
}

/** One project of one company, as the project META says it exists now: `projectCreatedAt` is its `createdAt`. */
export interface LearningScope { orgId: OrgId; project: string; projectCreatedAt: string }
/** What a cleanup job needs: the partition, with no judgement of which project it belongs to. */
export type RawLearningScope = { orgId: OrgId; project: string; projectCreatedAt?: undefined };

const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Learning could not be read or written. Try again.");
const invalid = (what: string) => agentXError("CONFIG_INVALID", `${what} is not valid.`);
const isConditionFailure = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";
const cancellationCodes = (error: unknown): string[] | undefined => error instanceof Error && error.name === "TransactionCanceledException"
  ? ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((reason) => reason.Code ?? "None") : undefined;
const failedIndexes = (error: unknown): number[] => (cancellationCodes(error) ?? []).flatMap((code, index) => code === "ConditionalCheckFailed" ? [index] : []);

/** The scope with its `projectCreatedAt` as a canonical instant, so the text stored and compared is one form of it. */
function normalized(scope: LearningScope): LearningScope {
  const time = Date.parse(scope.projectCreatedAt);
  if (!Number.isFinite(time)) throw invalid("The project's creation time");
  return { ...scope, projectCreatedAt: new Date(time).toISOString() };
}
const pcSeconds = (scope: LearningScope) => Math.floor(Date.parse(scope.projectCreatedAt) / 1000);
const keyOf = (scope: { orgId: OrgId; project: string }, sk: string) => projectLearningKey(scope.orgId, scope.project, sk);

// ---- sort keys

export const correctionSk = (createdAtIso: string, id: string): string => `CORRECTION#${createdAtIso}#${id}`;
export const sourceSk = (sourceKey: string): string => `SOURCE#${sourceKey}`;
export const suggestionSk = (id: string): string => `SUGGESTION#${id}`;
export const dismissedSk = (signatureHash: string): string => `DISMISSED#${signatureHash}`;
const dailySk = (day: string, scope: LearningScope) => `DAILY#${day}#${String(pcSeconds(scope))}`;
const rateSk = (actor: string, window: number, scope: LearningScope) => `RATE#${actor}#${String(window)}#${String(pcSeconds(scope))}`;

// ---- single-item reads

async function getRaw(deps: LearningDeps, scope: { orgId: OrgId; project: string }, sk: string): Promise<Item | undefined> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(scope, sk), ConsistentRead: true })) as { Item?: Item };
  return found.Item;
}

/** One item of the project's partition, or undefined when it is absent, expired, written for an earlier project, or not well formed for its kind. */
export async function getLearningItem(deps: LearningDeps, scope: LearningScope, sk: string): Promise<Item | undefined> {
  const checked = normalized(scope);
  const item = await getRaw(deps, checked, sk);
  return item !== undefined && visibility(item, { nowMs: deps.now(), projectCreatedAt: checked.projectCreatedAt }) === "visible" ? item : undefined;
}

function parseState(item: Item): LearningState | undefined {
  const clamp = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : value);
  const parsed = LearningStateSchema.safeParse({ ...item, openSuggestions: clamp(item["openSuggestions"]), liveCorrections: clamp(item["liveCorrections"]), pendingRules: clamp(item["pendingRules"]) });
  return parsed.success ? parsed.data : undefined;
}

/** The project's STATE, or undefined when there is none for this project (a project created again has none until its first write). Counters never read below zero. */
export async function readLearningState(deps: LearningDeps, scope: LearningScope): Promise<LearningState | undefined> {
  const item = await getLearningItem(deps, scope, "STATE");
  return item === undefined ? undefined : parseState(item);
}

// ---- STATE: created on the first write, and started again for a project created again

/**
 * The STATE for `scope`, written if there is none. A STATE of an earlier project is replaced (the counters start at zero; the revision goes on). `"stale"` means the project
 * META now says the project is newer than the caller's `projectCreatedAt`: the caller must read the project again.
 */
async function ensureState(deps: LearningDeps, scope: LearningScope): Promise<LearningState | "stale"> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await getRaw(deps, scope, "STATE");
    const fresh = (revision: number) => ({ ...keyOf(scope, "STATE"), entityType: "LEARNING_STATE", orgId: scope.orgId, revision, projectCreatedAt: scope.projectCreatedAt, openSuggestions: 0, liveCorrections: 0, pendingRules: 0 });
    try {
      if (raw === undefined) {
        await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: fresh(0), ConditionExpression: "attribute_not_exists(pk)" }));
        return LearningStateSchema.parse(fresh(0));
      }
      if (sameProject(raw["projectCreatedAt"], scope.projectCreatedAt)) {
        const state = parseState(raw);
        if (state === undefined) throw unavailable();
        return state;
      }
      const older = typeof raw["projectCreatedAt"] !== "string" || !Number.isFinite(Date.parse(raw["projectCreatedAt"])) || Date.parse(raw["projectCreatedAt"]) < Date.parse(scope.projectCreatedAt);
      if (!older) return "stale";
      const revision = typeof raw["revision"] === "number" && Number.isInteger(raw["revision"]) && raw["revision"] >= 0 ? raw["revision"] + 1 : 1;
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName, Item: fresh(revision),
        ConditionExpression: "#revision = :seenRevision AND projectCreatedAt = :seenCreated", ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: { ":seenRevision": raw["revision"], ":seenCreated": raw["projectCreatedAt"] },
      }));
      return LearningStateSchema.parse(fresh(revision));
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }
  throw unavailable();
}

// ---- partition reads: paged, with a budget and a resume cursor

export interface PartitionReadOptions {
  /** Only sort keys that begin with this. */
  prefix?: string;
  /** Resume after this sort key (the `cursor` of the last call). */
  cursor?: string;
  /** Items looked at in one call, counting the ones a filter hides. */
  maxItems?: number;
  /** Queries made in one call. */
  maxPages?: number;
  pageSize?: number;
}
export interface PartitionPage { items: Item[]; scanned: number; cursor?: string }

/**
 * A budgeted page of the project's partition, in sort-key order. With a `projectCreatedAt` in the scope, items that are expired or were written for another project are left out (the
 * cursor still moves over them); without one, every item is returned, which is what cleanup jobs need. `cursor` is set when more remains, for the next call to resume after.
 */
export async function readLearningPartition(deps: LearningDeps, scope: LearningScope | RawLearningScope, options: PartitionReadOptions = {}): Promise<PartitionPage> {
  const checked = scope.projectCreatedAt === undefined ? scope : normalized(scope);
  const maxItems = options.maxItems ?? 200, maxPages = options.maxPages ?? 5, pageSize = options.pageSize ?? 100;
  if (!Number.isInteger(maxItems) || maxItems < 1 || !Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(pageSize) || pageSize < 1) throw invalid("The read budget");
  const pk = keyOf(checked, "STATE").pk;
  const items: Item[] = [];
  let scanned = 0, cursor = options.cursor, more = true;
  for (let pages = 0; pages < maxPages && scanned < maxItems && more; pages += 1) {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: options.prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ...(options.prefix === undefined ? {} : { ":prefix": options.prefix }) },
      ConsistentRead: true,
      Limit: Math.min(pageSize, maxItems - scanned),
      ...(cursor === undefined ? {} : { ExclusiveStartKey: { pk, sk: cursor } }),
    })) as { Items?: Item[]; LastEvaluatedKey?: { sk?: unknown } };
    const page = response.Items ?? [];
    scanned += page.length;
    for (const item of page) {
      if (checked.projectCreatedAt === undefined || visibility(item, { nowMs: deps.now(), projectCreatedAt: checked.projectCreatedAt }) === "visible") items.push(item);
    }
    const last = response.LastEvaluatedKey?.sk;
    more = typeof last === "string";
    cursor = typeof last === "string" ? last : undefined;
    if (page.length === 0 && more) throw unavailable();
  }
  return { items, scanned, ...(more && cursor !== undefined ? { cursor } : {}) };
}

/** How many live corrections the project holds, counted from the table. More than `limit` is reported as `limit` + 1 (and so is a count the budget could not finish). */
async function countLiveCorrections(deps: LearningDeps, scope: LearningScope, limit: number): Promise<number> {
  let count = 0, cursor: string | undefined;
  for (let pages = 0; pages < 20; pages += 1) {
    const page = await readLearningPartition(deps, scope, { prefix: "CORRECTION#", ...(cursor === undefined ? {} : { cursor }), maxItems: 500, maxPages: 1, pageSize: 500 });
    count += page.items.length;
    if (count > limit) return limit + 1;
    cursor = page.cursor;
    if (cursor === undefined) return count;
  }
  return limit + 1;
}

// ---- capture: a correction, its source record, the counters and the caps, in one transaction

export type CaptureLimit = "remember" | "automatic" | "automatic_pr";
export interface CaptureInput {
  id: string;
  stage: LearningStage;
  source: LearningCorrectionSource;
  /** One per source (a comment, a decision, a PR comment): a repeat of it finds the first correction. */
  sourceKey: string;
  sourceRef: LearningSourceRef;
  taskId: string;
  text?: string;
  signature: string[];
  author: string;
  githubUserId?: string;
  standing: LearningStanding;
  rememberedBy?: string;
  linkedTo?: string;
  bodyDigest?: string;
  /** Which cap the capture counts against: a person's Remember, an automatic capture, or an automatic PR comment (which also counts as automatic). */
  limit: CaptureLimit;
  /** The person whose Remember rate is used (`limit: "remember"`). */
  actor?: string;
}
export type CaptureRefusal = "store_full" | "daily_cap" | "pr_daily_cap" | "rate_limited" | "stale";
export type CaptureResult =
  | { ok: true; created: true; correction: LearningCorrection }
  | { ok: true; created: false; correctionId: string; correctionSk: string; bodyDigest?: string }
  | { ok: false; reason: CaptureRefusal };

async function existingSource(deps: LearningDeps, scope: LearningScope, sourceKey: string): Promise<CaptureResult | undefined> {
  const found = await getLearningItem(deps, scope, sourceSk(sourceKey));
  if (found === undefined || typeof found["correctionId"] !== "string" || typeof found["correctionSk"] !== "string") return undefined;
  return { ok: true, created: false, correctionId: found["correctionId"], correctionSk: found["correctionSk"], ...(typeof found["bodyDigest"] === "string" ? { bodyDigest: found["bodyDigest"] } : {}) };
}

/**
 * Writes one correction under the caps. Returns `created: false` for a source that was captured already (nothing is counted again) and `ok: false` with a fixed reason when a cap
 * holds. Standing, author and stage are the caller's; this layer stores what it is given and never works them out.
 */
export async function captureCorrection(deps: LearningDeps, rawScope: LearningScope, input: CaptureInput): Promise<CaptureResult> {
  const scope = normalized(rawScope);
  if (input.limit === "remember" && (input.actor === undefined || input.actor.length === 0)) throw invalid("The person");
  const nowMs = deps.now();
  const at = new Date(nowMs).toISOString();
  const expires = learningExpiry(nowMs);

  const state = await ensureState(deps, scope);
  if (state === "stale") return { ok: false, reason: "stale" };

  const repeat = await existingSource(deps, scope, input.sourceKey);
  if (repeat !== undefined) return repeat;

  if (state.liveCorrections >= LEARNING_LIVE_CORRECTIONS_MAX) {
    // The counter can run high: the TTL deletes expired corrections without telling it. Count them before refusing, and put the true number back.
    const live = await countLiveCorrections(deps, scope, LEARNING_LIVE_CORRECTIONS_MAX);
    if (live >= LEARNING_LIVE_CORRECTIONS_MAX) return { ok: false, reason: "store_full" };
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: keyOf(scope, "STATE"), UpdateExpression: "SET liveCorrections = :live",
        ConditionExpression: "projectCreatedAt = :pc AND liveCorrections = :seen", ExpressionAttributeValues: { ":live": live, ":seen": state.liveCorrections, ":pc": scope.projectCreatedAt },
      }));
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }

  const candidate = {
    id: input.id, stage: input.stage, source: input.source, sourceRef: input.sourceRef, taskId: input.taskId,
    ...(input.text === undefined ? {} : { text: input.text }), signature: input.signature, author: input.author,
    ...(input.githubUserId === undefined ? {} : { githubUserId: input.githubUserId }), standing: input.standing,
    ...(input.rememberedBy === undefined ? {} : { rememberedBy: input.rememberedBy }), ...(input.linkedTo === undefined ? {} : { linkedTo: input.linkedTo }),
    createdAt: at, projectCreatedAt: scope.projectCreatedAt, [INDEX_EXPIRY_ATTRIBUTE]: expires,
  };
  const parsed = LearningCorrectionSchema.safeParse(candidate);
  if (!parsed.success) throw invalid("The correction");
  const correction = parsed.data;
  const correctionKey = keyOf(scope, correctionSk(at, correction.id));

  const day = at.slice(0, 10);
  const window = Math.floor(nowMs / 1000 / LEARNING_REMEMBER_WINDOW_SECONDS);
  const pr = input.limit === "automatic_pr";
  const items: TransactItem[] = [
    { Put: {
      TableName: deps.tableName,
      Item: { ...keyOf(scope, sourceSk(input.sourceKey)), entityType: "LEARNING_SOURCE", orgId: scope.orgId, correctionId: correction.id, correctionSk: correctionKey.sk, ...(input.bodyDigest === undefined ? {} : { bodyDigest: input.bodyDigest }), projectCreatedAt: scope.projectCreatedAt, [INDEX_EXPIRY_ATTRIBUTE]: expires },
      ConditionExpression: `attribute_not_exists(pk) OR ${INDEX_EXPIRY_ATTRIBUTE} <= :now`, ExpressionAttributeValues: { ":now": Math.floor(nowMs / 1000) },
    } },
    { Put: { TableName: deps.tableName, Item: { ...correctionKey, entityType: "LEARNING_CORRECTION", orgId: scope.orgId, ...correction }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Update: {
      TableName: deps.tableName, Key: keyOf(scope, "STATE"), UpdateExpression: "ADD liveCorrections :one",
      ConditionExpression: "projectCreatedAt = :pc AND liveCorrections < :cap", ExpressionAttributeValues: { ":one": 1, ":pc": scope.projectCreatedAt, ":cap": LEARNING_LIVE_CORRECTIONS_MAX },
    } },
  ];
  if (input.limit !== "remember") {
    items.push({ Update: {
      TableName: deps.tableName, Key: keyOf(scope, dailySk(day, scope)),
      UpdateExpression: `SET entityType = :entity, orgId = :org, projectCreatedAt = :pc, ${INDEX_EXPIRY_ATTRIBUTE} = :exp ADD autoCount :one, prCount :prOne`,
      ConditionExpression: pr ? "attribute_not_exists(pk) OR (autoCount < :max AND prCount < :prMax)" : "attribute_not_exists(pk) OR autoCount < :max",
      ExpressionAttributeValues: { ":entity": "LEARNING_DAILY", ":org": scope.orgId, ":pc": scope.projectCreatedAt, ":exp": shortLearningExpiry(nowMs), ":one": 1, ":prOne": pr ? 1 : 0, ":max": LEARNING_DAILY_AUTOMATIC_MAX, ...(pr ? { ":prMax": LEARNING_DAILY_PR_MAX } : {}) },
    } });
  } else {
    items.push({ Update: {
      TableName: deps.tableName, Key: keyOf(scope, rateSk(input.actor!, window, scope)),
      UpdateExpression: `SET entityType = :entity, orgId = :org, projectCreatedAt = :pc, ${INDEX_EXPIRY_ATTRIBUTE} = :exp ADD rememberCount :one`,
      ConditionExpression: "attribute_not_exists(pk) OR rememberCount < :max",
      ExpressionAttributeValues: { ":entity": "LEARNING_RATE", ":org": scope.orgId, ":pc": scope.projectCreatedAt, ":exp": shortLearningExpiry(nowMs), ":one": 1, ":max": LEARNING_REMEMBER_MAX },
    } });
  }

  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return { ok: true, created: true, correction };
  } catch (error) {
    const failed = failedIndexes(error);
    if (cancellationCodes(error) === undefined) throw error;
    if (failed.includes(0)) {
      // A racing capture of the same source got there first.
      const raced = await existingSource(deps, scope, input.sourceKey);
      if (raced !== undefined) return raced;
    }
    if (failed.includes(2)) {
      const current = await getRaw(deps, scope, "STATE");
      return !sameProject(current?.["projectCreatedAt"], scope.projectCreatedAt) ? { ok: false, reason: "stale" } : { ok: false, reason: "store_full" };
    }
    if (failed.includes(3)) {
      if (input.limit === "remember") return { ok: false, reason: "rate_limited" };
      const daily = await getRaw(deps, scope, dailySk(day, scope));
      return pr && typeof daily?.["prCount"] === "number" && daily["prCount"] >= LEARNING_DAILY_PR_MAX ? { ok: false, reason: "pr_daily_cap" } : { ok: false, reason: "daily_cap" };
    }
    throw unavailable();
  }
}

// ---- suggestions

export interface NewSuggestion {
  id: string;
  stage: LearningStage;
  correctionIds: string[];
  allFromOnePerson: boolean;
  proposedText?: string;
  signature: string[];
  lessSafe: boolean;
  kinds: string[];
  overlaps: string[];
  dismissNote?: string;
}
export type OpenSuggestionResult = { ok: true; suggestion: LearningSuggestion } | { ok: false; reason: "suggestion_cap" | "stale" | "duplicate" };

/**
 * Writes a new open suggestion under the STATE revision (the serialization point for grouping: `expectedStateRevision`, by default the revision just read) and the cap of 20
 * suggestions that are not terminal. The 21st is refused with `suggestion_cap` and waits for one to close.
 */
export async function openSuggestion(deps: LearningDeps, rawScope: LearningScope, input: NewSuggestion, options: { expectedStateRevision?: number } = {}): Promise<OpenSuggestionResult> {
  const scope = normalized(rawScope);
  const state = await ensureState(deps, scope);
  if (state === "stale") return { ok: false, reason: "stale" };
  const expected = options.expectedStateRevision ?? state.revision;
  const nowMs = deps.now();
  const parsed = LearningSuggestionSchema.safeParse({
    ...input, status: "open", revision: 0, createdAt: new Date(nowMs).toISOString(), projectCreatedAt: scope.projectCreatedAt,
  });
  if (!parsed.success) throw invalid("The suggestion");
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      {
        Update: {
          TableName: deps.tableName, Key: keyOf(scope, "STATE"), UpdateExpression: "SET #revision = #revision + :one ADD openSuggestions :one",
          ConditionExpression: "projectCreatedAt = :pc AND #revision = :expected AND openSuggestions < :cap", ExpressionAttributeNames: { "#revision": "revision" },
          ExpressionAttributeValues: { ":one": 1, ":pc": scope.projectCreatedAt, ":expected": expected, ":cap": LEARNING_OPEN_SUGGESTIONS_MAX },
        },
      },
      { Put: { TableName: deps.tableName, Item: { ...keyOf(scope, suggestionSk(parsed.data.id)), entityType: "LEARNING_SUGGESTION", orgId: scope.orgId, ...parsed.data }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
    return { ok: true, suggestion: parsed.data };
  } catch (error) {
    const failed = failedIndexes(error);
    if (cancellationCodes(error) === undefined) throw error;
    if (failed.includes(1)) return { ok: false, reason: "duplicate" };
    const current = await readLearningState(deps, scope);
    if (current === undefined) return { ok: false, reason: "stale" };
    return current.openSuggestions >= LEARNING_OPEN_SUGGESTIONS_MAX ? { ok: false, reason: "suggestion_cap" } : { ok: false, reason: "stale" };
  }
}

export interface TerminalMove {
  id: string;
  expectedRevision: number;
  status: LearningTerminalStatus;
  decidedBy?: string;
  ruleId?: string;
  dismissKind?: z.infer<typeof LearningDismissKindSchema>;
}

/**
 * The two writes that end a suggestion, for a caller to put in its own transaction (B6's settle composes them with the rule and the audit event): the suggestion goes terminal,
 * loses `proposedText` and `dismissNote`, and gets `terminalAt` and an `indexExpiresAt` 180 days on; STATE counts one fewer open. They hold only while the suggestion is at
 * `expectedRevision` and not already terminal.
 */
export function terminalSuggestionItems(deps: LearningDeps, rawScope: LearningScope, move: TerminalMove): TransactItem[] {
  const scope = normalized(rawScope);
  if (!(LEARNING_TERMINAL_STATUSES as readonly string[]).includes(move.status)) throw invalid("The suggestion state");
  const nowMs = deps.now();
  const at = new Date(nowMs).toISOString();
  const extras: Record<string, unknown> = {
    ...(move.decidedBy === undefined ? {} : { decidedBy: move.decidedBy, decidedAt: at }),
    ...(move.ruleId === undefined ? {} : { ruleId: move.ruleId }),
    ...(move.dismissKind === undefined ? {} : { dismissKind: move.dismissKind }),
  };
  const extraNames = Object.keys(extras);
  return [
    {
      Update: {
        TableName: deps.tableName, Key: keyOf(scope, suggestionSk(move.id)),
        UpdateExpression: `SET #status = :status, terminalAt = :at, ${INDEX_EXPIRY_ATTRIBUTE} = :exp, #revision = #revision + :one${extraNames.map((name) => `, ${name} = :x_${name}`).join("")} REMOVE proposedText, dismissNote`,
        ConditionExpression: "projectCreatedAt = :pc AND #revision = :expected AND #status <> :accepted AND #status <> :dismissed AND #status <> :withdrawn AND #status <> :expired",
        ExpressionAttributeNames: { "#status": "status", "#revision": "revision" },
        ExpressionAttributeValues: {
          ":status": move.status, ":at": at, ":exp": learningExpiry(nowMs), ":one": 1, ":pc": scope.projectCreatedAt, ":expected": move.expectedRevision,
          ":accepted": "accepted", ":dismissed": "dismissed", ":withdrawn": "withdrawn", ":expired": "expired",
          ...Object.fromEntries(extraNames.map((name) => [`:x_${name}`, extras[name]])),
        },
      },
    },
    {
      Update: {
        TableName: deps.tableName, Key: keyOf(scope, "STATE"), UpdateExpression: "ADD openSuggestions :minus",
        ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc", ExpressionAttributeValues: { ":minus": -1, ":pc": scope.projectCreatedAt },
      },
    },
  ];
}

export type CloseSuggestionResult = { ok: true; suggestion: LearningSuggestion } | { ok: false; reason: "missing" | "stale" | "already_terminal" };

/** Moves a suggestion to a terminal state (`accepted`, `dismissed`, `withdrawn`, `expired`), dropping its text and giving it its own 180-day expiry. */
export async function closeSuggestion(deps: LearningDeps, rawScope: LearningScope, move: TerminalMove): Promise<CloseSuggestionResult> {
  const scope = normalized(rawScope);
  const current = await getLearningItem(deps, scope, suggestionSk(move.id));
  if (current === undefined) return { ok: false, reason: "missing" };
  if ((LEARNING_TERMINAL_STATUSES as readonly string[]).includes(String(current["status"]))) return { ok: false, reason: "already_terminal" };
  if (current["revision"] !== move.expectedRevision) return { ok: false, reason: "stale" };
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: terminalSuggestionItems(deps, scope, move) }));
  } catch (error) {
    if (cancellationCodes(error) === undefined) throw error;
    return { ok: false, reason: "stale" };
  }
  const after = await getLearningItem(deps, scope, suggestionSk(move.id));
  const parsed = LearningSuggestionSchema.safeParse(after);
  if (!parsed.success) throw unavailable();
  return { ok: true, suggestion: parsed.data };
}

/** The write that removes a correction's text (a rule was accepted from it), for a caller's transaction. */
export function clearCorrectionTextItem(deps: LearningDeps, rawScope: LearningScope, sk: string): TransactItem {
  const scope = normalized(rawScope);
  return { Update: { TableName: deps.tableName, Key: keyOf(scope, sk), UpdateExpression: "REMOVE #text", ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc", ExpressionAttributeNames: { "#text": "text" }, ExpressionAttributeValues: { ":pc": scope.projectCreatedAt } } };
}

/** Removes `text` from the named corrections (a missing one is skipped: it was forgotten or has expired). Everything else on them stays. */
export async function clearCorrectionText(deps: LearningDeps, scope: LearningScope, sks: string[]): Promise<void> {
  for (const sk of sks) {
    const item = clearCorrectionTextItem(deps, scope, sk).Update!;
    try {
      await deps.documentClient.send(new UpdateCommand({ TableName: item.TableName, Key: item.Key, UpdateExpression: item.UpdateExpression, ConditionExpression: item.ConditionExpression, ExpressionAttributeNames: item.ExpressionAttributeNames, ExpressionAttributeValues: item.ExpressionAttributeValues }));
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }
}

// ---- dismissed patterns

/** Remembers a dismissed pattern (hashed tokens, no text) for 180 days, so the same group is not suggested again. */
export async function putDismissed(deps: LearningDeps, rawScope: LearningScope, input: { signatureHash: string; suggestionId: string; signature: string[] }): Promise<void> {
  const scope = normalized(rawScope);
  const nowMs = deps.now();
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: {
      ...keyOf(scope, dismissedSk(input.signatureHash)), entityType: "LEARNING_DISMISSED", orgId: scope.orgId, signature: input.signature, suggestionId: input.suggestionId,
      dismissedAt: new Date(nowMs).toISOString(), projectCreatedAt: scope.projectCreatedAt, [INDEX_EXPIRY_ATTRIBUTE]: learningExpiry(nowMs),
    },
  }));
}
