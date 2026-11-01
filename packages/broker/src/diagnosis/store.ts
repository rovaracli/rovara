// Live interaction F2: what a diagnosis keeps, and the rates and the "one open diagnosis per error" rule around it.
//
//   DIAGNOSIS#<id> / REQUEST   ids, the tier, the error reference (codes and ids), the state, and WHILE IT WAITS the context text the turn is given. The text is removed when the request settles and the
//                              item then lives 30 days; an unanswered request expires on its own within a day.
//   DIAGNOSIS#<id> / RECORD    the result: the proposals (already read again by `sanitizeDiagnosis`), the model and the cost. No error text, no requester. 30 days.
//   DIAGNOSIS#<id> / PERSON    who asked. Kept apart, with an index (`DIAGNOSISBY#<developerId>`), so erasing the person removes the link and keeps the diagnosis.
//   DIAGNOSISOPEN              "one open diagnosis per ErrorRef": the same error answers the existing diagnosis for an hour, and spends nothing.
//   DIAGNOSISRATE              the counters: light 10 an hour per person and 50 a day per project; deep 3 a day per person.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  DIAGNOSIS_DEDUPE_SECONDS, DIAGNOSIS_RATE, DIAGNOSIS_REFUSALS, DIAGNOSIS_RETENTION_DAYS, DiagnosisRecordSchema, ErrorRefSchema, INDEX_EXPIRY_ATTRIBUTE,
  agentXError, diagnosisByPersonKey, diagnosisByPersonPk, diagnosisKey, diagnosisOpenKey, diagnosisRateKey, errorRefKey,
  type DiagnosisRecord, type DiagnosisTier, type ErrorRef, type OrgId,
} from "@agentx/contracts";

type Client = { send(command: unknown): Promise<unknown> };
type Item = Record<string, unknown>;
type TransactItem = Record<string, unknown>;

export interface DiagnosisStoreDependencies { documentClient: Client; tableName: string; now: () => number }

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A waiting request is kept a day: long enough to be read, short enough that the context text it holds does not linger. */
export const REQUEST_WAITING_SECONDS = 86_400;
/** A request still waiting after this long reads as failed (the chat service never answered). */
export const REQUEST_STALE_MS = 15 * 60_000;
/** How many times the counters are read again after losing a race to another request. */
export const RATE_RACE_ATTEMPTS = 4;

const getItem = async (deps: DiagnosisStoreDependencies, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

/** The diagnosis id of a request: the same person, request and tier always give the same id, so a repeat is the same diagnosis and spends nothing. */
export function diagnosisIdFor(orgId: string, developerId: string, requestId: string, tier: DiagnosisTier): string {
  const digest = createHash("sha256").update(`diagnosis\0${orgId}\0${developerId}\0${requestId}\0${tier}`, "utf8").digest();
  let value = BigInt(`0x${digest.subarray(0, 13).toString("hex")}`);
  let out = "";
  for (let index = 0; index < 20; index += 1) { out = "0123456789abcdefghijklmnopqrstuvwxyz"[Number(value % 36n)]! + out; value /= 36n; }
  return `dgn_${out}`;
}

/** The queue event id of a diagnosis: stable per diagnosis, in the queue's event-id form (the queue deduplicates on it). */
export const diagnosisEventId = (diagnosisId: string): string => `Ev${createHash("sha256").update(diagnosisId, "utf8").digest("hex").slice(0, 32)}`;

// ---- the items

export interface DiagnosisRequest {
  diagnosisId: string;
  tier: DiagnosisTier;
  errorRef: ErrorRef;
  project: string;
  state: "queued" | "ready" | "failed";
  createdAt: string;
  /** Light: the context text the turn is given, while it waits. */
  context?: string | undefined;
  /** Deep: the light diagnosis it was asked for from. */
  basedOn?: string | undefined;
  /** Deep: the task that is reading the repositories. */
  taskId?: string | undefined;
}

export async function readDiagnosisRequest(deps: DiagnosisStoreDependencies, orgId: OrgId, diagnosisId: string): Promise<DiagnosisRequest | undefined> {
  const item = await getItem(deps, diagnosisKey(orgId, diagnosisId, "REQUEST"));
  if (item === undefined || item["orgId"] !== orgId || item["entityType"] !== "DIAGNOSIS_REQUEST") return undefined;
  const errorRef = ErrorRefSchema.safeParse(item["errorRef"]);
  const tier = item["tier"], stored = item["state"];
  // A deep diagnosis ends in its task's own result transaction, which keeps the first end it was given in `ended` (it can never fail on this item); that end is the state once there is one.
  const ended = typeof item["ended"] === "object" && item["ended"] !== null ? (item["ended"] as { state?: unknown }).state : undefined;
  const state = stored === "queued" && tier === "deep" && (ended === "ready" || ended === "failed") ? ended : stored;
  if (!errorRef.success || (tier !== "light" && tier !== "deep") || (state !== "queued" && state !== "ready" && state !== "failed") || typeof item["project"] !== "string" || typeof item["createdAt"] !== "string") return undefined;
  return {
    diagnosisId, tier, errorRef: errorRef.data, project: item["project"], state, createdAt: item["createdAt"],
    ...(typeof item["context"] === "string" ? { context: item["context"] } : {}),
    ...(typeof item["basedOn"] === "string" ? { basedOn: item["basedOn"] } : {}),
    ...(typeof item["taskId"] === "string" ? { taskId: item["taskId"] } : {}),
  };
}

/** The result, or undefined: not there, another org's, or not readable as a record (a record that does not parse is no record). */
export async function readDiagnosisRecord(deps: DiagnosisStoreDependencies, orgId: OrgId, diagnosisId: string): Promise<DiagnosisRecord | undefined> {
  const item = await getItem(deps, diagnosisKey(orgId, diagnosisId, "RECORD"));
  if (item === undefined || item["orgId"] !== orgId) return undefined;
  const { pk: _pk, sk: _sk, entityType: _type, orgId: _org, [INDEX_EXPIRY_ATTRIBUTE]: _expires, ...record } = item;
  void _pk; void _sk; void _type; void _org; void _expires;
  const parsed = DiagnosisRecordSchema.safeParse(record);
  return parsed.success ? parsed.data : undefined;
}

/** Who asked, from the person-link row; undefined once they were erased. */
export async function readDiagnosisRequester(deps: DiagnosisStoreDependencies, orgId: OrgId, diagnosisId: string): Promise<string | undefined> {
  const item = await getItem(deps, diagnosisKey(orgId, diagnosisId, "PERSON"));
  return item !== undefined && item["orgId"] === orgId && typeof item["requestedBy"] === "string" ? item["requestedBy"] : undefined;
}

// ---- the rates

interface RateStep { room: boolean; item: TransactItem }

/** One fixed-window counter as a step of the request's own transaction: the new count is set from the count that was read, conditional on it, so two requests cannot both take the last place. */
async function rateStep(deps: DiagnosisStoreDependencies, key: { pk: string; sk: string }, orgId: OrgId, limit: number, windowMs: number): Promise<RateStep> {
  const stored = await getItem(deps, key);
  const nowMs = deps.now();
  const window = Math.floor(nowMs / windowMs) * windowMs;
  const seenWindow = stored?.["windowStart"], seenCount = stored?.["count"];
  if (stored !== undefined && (typeof seenWindow !== "number" || typeof seenCount !== "number")) throw agentXError("RUNTIME_UNAVAILABLE", "diagnosis counters can't be read");
  const count = typeof seenWindow === "number" && seenWindow === window && typeof seenCount === "number" ? seenCount : 0;
  return {
    room: count < limit,
    item: { Update: {
      TableName: deps.tableName, Key: key,
      UpdateExpression: "SET entityType = :type, orgId = :org, windowStart = :window, #count = :next, #expires = :expires",
      ConditionExpression: stored === undefined ? "attribute_not_exists(pk)" : "windowStart = :seenWindow AND #count = :seenCount",
      ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: {
        ":type": "DIAGNOSIS_RATE", ":org": orgId, ":window": window, ":next": count + 1, ":expires": Math.floor((window + 2 * windowMs) / 1000),
        ...(stored === undefined ? {} : { ":seenWindow": seenWindow, ":seenCount": seenCount }),
      },
    } },
  };
}

// ---- admitting

export interface DiagnosisAdmission {
  orgId: OrgId;
  developerId: string;
  requestId: string;
  tier: DiagnosisTier;
  errorRef: ErrorRef;
  project: string;
  /** Light: the context text the turn will be given. */
  context?: string | undefined;
  /** Deep: the light diagnosis it follows. */
  basedOn?: string | undefined;
}

const isCancelled = (error: unknown): boolean => (error as { name?: string }).name === "TransactionCanceledException";

/**
 * Spends the rates, takes the "one open diagnosis" place for the error and records the request, its person link and the erasure index, in one transaction. Answers the diagnosis id and whether
 * this call made it (`created`): a repeat of the same request, or the same error while its diagnosis is open (an hour), answers the existing one and spends nothing.
 * `TOO_MANY_REQUESTS` when a counter is full.
 */
export async function admitDiagnosis(deps: DiagnosisStoreDependencies, input: DiagnosisAdmission): Promise<{ diagnosisId: string; created: boolean }> {
  const { orgId } = input;
  const diagnosisId = diagnosisIdFor(orgId, input.developerId, input.requestId, input.tier);
  if (await getItem(deps, diagnosisKey(orgId, diagnosisId, "REQUEST")) !== undefined) return { diagnosisId, created: false };
  const errorKey = errorRefKey(input.errorRef);
  const openKey = diagnosisOpenKey(orgId, input.tier, errorKey);
  const openNow = async (): Promise<string | undefined> => {
    const open = await getItem(deps, openKey);
    return open !== undefined && typeof open["diagnosisId"] === "string" && typeof open["expiresAt"] === "number" && open["expiresAt"] > deps.now() ? open["diagnosisId"] : undefined;
  };
  for (let attempt = 1; ; attempt += 1) {
    const existing = await openNow();
    if (existing !== undefined) return { diagnosisId: existing, created: false };
    const nowMs = deps.now();
    const steps = input.tier === "light"
      ? [
        await rateStep(deps, diagnosisRateKey(orgId, "light_person", input.developerId), orgId, DIAGNOSIS_RATE.lightPerPersonPerHour, HOUR_MS),
        await rateStep(deps, diagnosisRateKey(orgId, "light_project", input.project), orgId, DIAGNOSIS_RATE.lightPerProjectPerDay, DAY_MS),
      ]
      : [await rateStep(deps, diagnosisRateKey(orgId, "deep_person", input.developerId), orgId, DIAGNOSIS_RATE.deepPerPersonPerDay, DAY_MS)];
    if (steps.some((step) => !step.room)) throw agentXError("TOO_MANY_REQUESTS", input.tier === "light" ? DIAGNOSIS_REFUSALS.rateLimited : DIAGNOSIS_REFUSALS.deepRateLimited);
    const waitingUntil = Math.floor(nowMs / 1000) + REQUEST_WAITING_SECONDS;
    const keep = Math.floor(nowMs / 1000) + DIAGNOSIS_RETENTION_DAYS * 86_400;
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        ...steps.map((step) => step.item),
        { Put: { TableName: deps.tableName, Item: { ...openKey, entityType: "DIAGNOSIS_OPEN", orgId, diagnosisId, tier: input.tier, expiresAt: nowMs + DIAGNOSIS_DEDUPE_SECONDS * 1000, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + DIAGNOSIS_DEDUPE_SECONDS * 2 },
          ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now", ExpressionAttributeValues: { ":now": nowMs } } },
        { Put: { TableName: deps.tableName, Item: { ...diagnosisKey(orgId, diagnosisId, "REQUEST"), entityType: "DIAGNOSIS_REQUEST", orgId, diagnosisId, tier: input.tier, errorRef: input.errorRef, project: input.project, state: "queued", createdAt: new Date(nowMs).toISOString(),
          ...(input.context === undefined ? {} : { context: input.context }), ...(input.basedOn === undefined ? {} : { basedOn: input.basedOn }), [INDEX_EXPIRY_ATTRIBUTE]: waitingUntil },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: deps.tableName, Item: { ...diagnosisKey(orgId, diagnosisId, "PERSON"), entityType: "DIAGNOSIS_PERSON", orgId, diagnosisId, requestedBy: input.developerId, [INDEX_EXPIRY_ATTRIBUTE]: keep } } },
        { Put: { TableName: deps.tableName, Item: { ...diagnosisByPersonKey(orgId, input.developerId, diagnosisId), entityType: "DIAGNOSIS_BY", orgId, diagnosisId, [INDEX_EXPIRY_ATTRIBUTE]: keep } } },
      ] as never }));
      return { diagnosisId, created: true };
    } catch (error) {
      // Another call won the place at the same moment: if it was this very request or the same error, that is the answer.
      if (await getItem(deps, diagnosisKey(orgId, diagnosisId, "REQUEST")) !== undefined) return { diagnosisId, created: false };
      const raced = await openNow();
      if (raced !== undefined) return { diagnosisId: raced, created: false };
      if (!isCancelled(error)) throw error;
      // Only the counters moved (another person's request): read them again, a bounded number of times, without blaming the asker.
      if (attempt >= RATE_RACE_ATTEMPTS) throw agentXError("RUNTIME_UNAVAILABLE", "Couldn't diagnose this now.");
    }
  }
}

// ---- settling

/** The items that end a waiting request: its state (conditional on `queued`, so only the first ending counts), the context text removed, and, for a result, the record. */
export function diagnosisSettleItems(
  tableName: string, orgId: OrgId, diagnosisId: string, nowMs: number, outcome: { state: "failed" } | { state: "ready"; record: DiagnosisRecord },
): TransactItem[] {
  const keep = Math.floor(nowMs / 1000) + DIAGNOSIS_RETENTION_DAYS * 86_400;
  return [
    { Update: {
      TableName: tableName, Key: diagnosisKey(orgId, diagnosisId, "REQUEST"),
      UpdateExpression: "SET #state = :next, settledAt = :now, #expires = :keep REMOVE #context",
      ConditionExpression: "#state = :queued AND orgId = :org", ExpressionAttributeNames: { "#state": "state", "#expires": INDEX_EXPIRY_ATTRIBUTE, "#context": "context" },
      ExpressionAttributeValues: { ":next": outcome.state, ":queued": "queued", ":now": new Date(nowMs).toISOString(), ":keep": keep, ":org": orgId },
    } },
    ...(outcome.state === "ready" ? [{ Put: { TableName: tableName, Item: { ...diagnosisKey(orgId, diagnosisId, "RECORD"), entityType: "DIAGNOSIS_RECORD", orgId, ...outcome.record, [INDEX_EXPIRY_ATTRIBUTE]: keep } } }] : []),
  ];
}

/** Ends a waiting request. Answers whether this call ended it (a repeat answers false and writes nothing). A failure also frees the error's open place, so it can be asked about again. */
export async function settleDiagnosis(
  deps: DiagnosisStoreDependencies, orgId: OrgId, request: Pick<DiagnosisRequest, "diagnosisId" | "tier" | "errorRef">, outcome: { state: "failed" } | { state: "ready"; record: DiagnosisRecord },
): Promise<boolean> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: diagnosisSettleItems(deps.tableName, orgId, request.diagnosisId, deps.now(), outcome) }));
  } catch (error) {
    if (isCancelled(error)) return false;
    throw error;
  }
  if (outcome.state === "failed") await freeOpenPlace(deps, orgId, request);
  return true;
}

/** Lets go of the error's open place, only if it is still this diagnosis's. */
export async function freeOpenPlace(deps: DiagnosisStoreDependencies, orgId: OrgId, request: Pick<DiagnosisRequest, "diagnosisId" | "tier" | "errorRef">): Promise<void> {
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: diagnosisOpenKey(orgId, request.tier, errorRefKey(request.errorRef)), UpdateExpression: "SET expiresAt = :zero",
    ConditionExpression: "diagnosisId = :id", ExpressionAttributeValues: { ":zero": 0, ":id": request.diagnosisId },
  })).catch(() => undefined);
}

/** The diagnosis that is open for this error and tier now, if any (its id). */
export async function openDiagnosisFor(deps: DiagnosisStoreDependencies, orgId: OrgId, tier: DiagnosisTier, errorRef: ErrorRef): Promise<string | undefined> {
  const open = await getItem(deps, diagnosisOpenKey(orgId, tier, errorRefKey(errorRef)));
  return open !== undefined && typeof open["diagnosisId"] === "string" && typeof open["expiresAt"] === "number" && open["expiresAt"] > deps.now() ? open["diagnosisId"] : undefined;
}

/** Whether this call is the first to claim the "proposed" audit of a deep diagnosis (its result is audited by the first read of it, once). */
export async function claimProposedAudit(deps: DiagnosisStoreDependencies, orgId: OrgId, diagnosisId: string): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: diagnosisKey(orgId, diagnosisId, "REQUEST"), UpdateExpression: "SET audited = :yes",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(audited)", ExpressionAttributeValues: { ":yes": true },
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

// ---- erasure

/**
 * Removes a person's link to the diagnoses they asked for (the PERSON row of each, then the index item last), so a diagnosis stays and names no one. Bounded (`maxItems`) and resumable:
 * `complete` is false when more is left, and the next call goes on from the index. Org-scoped and idempotent.
 */
export async function eraseDiagnosisPerson(deps: Pick<DiagnosisStoreDependencies, "documentClient" | "tableName">, orgId: OrgId, developerId: string, options: { maxItems?: number } = {}): Promise<{ complete: boolean; removed: number }> {
  const maxItems = options.maxItems ?? 200;
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": diagnosisByPersonPk(orgId, developerId) }, Limit: maxItems, ConsistentRead: true,
  })) as { Items?: Item[]; LastEvaluatedKey?: unknown };
  let removed = 0;
  for (const item of response.Items ?? []) {
    const diagnosisId = item["diagnosisId"];
    if (typeof diagnosisId === "string" && item["orgId"] === orgId) {
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: diagnosisKey(orgId, diagnosisId, "PERSON") }));
    }
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: item["pk"] as string, sk: item["sk"] as string } }));
    removed += 1;
  }
  return { complete: response.LastEvaluatedKey === undefined, removed };
}
