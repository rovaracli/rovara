// TE-F1e (te-f1e.md item 3; design 5; DECISIONS 157, 163b D5, 165/165a, 203): the Cloud meter for a customer's PRODUCT model calls. Cloud only, and NOT the LiteLLM spend ledger (Rovara's own agent spend).
//
// TABLE (fork F6, confirmed): the existing State table (control-plane.ts, single-table pk/sk, PITR, RETAIN), with keys that all start `product-ai-meter#`, so the function's role is held to them with
// `dynamodb:LeadingKeys` `product-ai*` (with F1-d's `product-ai#` source items). No new stateful resource. The State stream's consumers ignore these keys (tests/unit/product-ai-meter.test.ts holds that).
//
// ITEMS (sk `meter`): `product-ai-meter#task#<taskId>`, `product-ai-meter#project#<orgId>#<project>#<yyyy-mm>`, `product-ai-meter#org#<orgId>#<yyyy-mm>`. The project item names the org too: projects are keyed by
// NAME per org, so two companies' "web" projects must never share an item (the brief's `#project#<projectId>` form would). The task item records its org and refuses another's. The month is UTC and turns on the 1st;
// a settle goes to the month its reservation was made in.
//
// MONEY RULE: DynamoDB conditions cannot add, so each item keeps `committed` = spent + reserved beside the two, and the condition `spent + reserved + :estimate <= cap` is written `committed <= :cap - :estimate`
// (the subtraction is done here; a negative limit is refused without a write). Reserve then settle: ONE TransactWriteItems over all three items, each with its own condition, so a call is reserved on all or none, and
// two calls racing for the last dollar cannot both win. The settle is never refused (DEC 165): it moves the reservation to the true cost, and when the SPEND passes a cap it marks that item `overrun`; the next call on
// that item is refused "budget exceeded by one call". A call cut off mid-stream settles at its reservation or more (`settleCost`), and a call that never settles keeps its reservation: the meter errs high, never low.
//
// HOLDS (forks F2, F3, F5, F8, confirmed): a whole run (an eval, or TE-F9's N real-model runs) is funded before its first call or not at all. `openHold` reserves the whole amount on the project and company month
// items (and the task item for `real-model-run`, never for an eval: DEC 203 replaces the per-task cap for the eval only) in ONE transaction with the hold item. Each call in the hold reserves on the hold item only;
// `closeHold` releases the unspent remainder and KEEPS any reservation whose call never settled (errs high). A hold expires at the run deadline plus 15 minutes; the next hold or reservation for the same project
// first closes expired holds in their own conditional write. No scheduler.
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { OrgId } from "@rovara-code/contracts";

export const PRODUCT_AI_METER_PREFIX = "product-ai-meter#";
const SK = "meter";
/** A hold lives this long past the run's own deadline (beyond the function's 10-minute timeout). */
export const PRODUCT_AI_HOLD_GRACE_MS = 15 * 60 * 1000;

export interface ProductAiMeterDependencies {
  readonly documentClient: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
  readonly now: () => number;
}

export interface ProductAiMeterCaps {
  readonly taskMicros: number;
  readonly taskCalls: number;
  readonly projectMonthMicros: number;
  /** The company ceiling's month cap; absent: the company item counts but caps nothing. */
  readonly companyMonthMicros?: number;
}

export type ProductAiCapItem = "task" | "project" | "company";
export type ProductAiReserveRefusal =
  | { readonly ok: false; readonly reason: "cap"; readonly item: ProductAiCapItem | "hold"; readonly capMicros?: number }
  | { readonly ok: false; readonly reason: "calls"; readonly item: "task" }
  | { readonly ok: false; readonly reason: "overrun"; readonly item: ProductAiCapItem | "hold" }
  | { readonly ok: false; readonly reason: "busy" };

interface CappedKey { readonly key: { readonly pk: string; readonly sk: string }; readonly item: ProductAiCapItem; readonly capMicros: number | undefined }
export interface ProductAiReservation { readonly orgId: OrgId; readonly reserveMicros: number; readonly items: readonly CappedKey[] }

const ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const ORG = /^org_[0-9a-z]{20}$/u;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const meterMonthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const NAMES = { "#o": "orgId", "#c": "committed", "#r": "reservedMicros", "#s": "spentMicros", "#n": "calls", "#ov": "overrun", "#cap": "capMicros" } as const;

export const productAiMeterKeys = {
  task: (taskId: string) => ({ pk: `${PRODUCT_AI_METER_PREFIX}task#${taskId}`, sk: SK }),
  /** A task-time eval's spend (fork F3): shown on the task's line, kept apart from its $2/200-call item. */
  taskEval: (taskId: string) => ({ pk: `${PRODUCT_AI_METER_PREFIX}task#${taskId}#eval`, sk: SK }),
  project: (orgId: string, project: string, month: string) => ({ pk: `${PRODUCT_AI_METER_PREFIX}project#${orgId}#${project}#${month}`, sk: SK }),
  company: (orgId: string, month: string) => ({ pk: `${PRODUCT_AI_METER_PREFIX}org#${orgId}#${month}`, sk: SK }),
  hold: (holdId: string) => ({ pk: `${PRODUCT_AI_METER_PREFIX}hold#${holdId}`, sk: SK }),
  holdIndex: (orgId: string, project: string, holdId: string) => ({ pk: `${PRODUCT_AI_METER_PREFIX}holds#${orgId}#${project}`, sk: holdId }),
};

function checkScope(orgId: string, project: string, taskId?: string): void {
  if (!ORG.test(orgId) || !PROJECT.test(project) || (taskId !== undefined && !ID.test(taskId))) throw new RangeError("not a usable meter scope");
}
function checkCaps(caps: ProductAiMeterCaps): void {
  for (const value of [caps.taskMicros, caps.taskCalls, caps.projectMonthMicros, ...(caps.companyMonthMicros === undefined ? [] : [caps.companyMonthMicros])]) if (!whole(value)) throw new RangeError("a cap must be a whole number");
}

const errorName = (error: unknown): string | undefined => (error instanceof Error ? error.name : undefined);
const reasons = (error: unknown): Array<{ Code?: string }> => ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []);

/** One capped reservation update: committed may not pass `cap - estimate`, an overrun item takes nothing, the item is the org's own. */
function reserveUpdate(deps: ProductAiMeterDependencies, target: CappedKey, orgId: string, estimate: number, calls?: { add: number; max: number }) {
  const capped = target.capMicros !== undefined;
  const names: Record<string, string> = { "#o": NAMES["#o"], "#c": NAMES["#c"], "#r": NAMES["#r"], ...(capped ? { "#ov": NAMES["#ov"], "#cap": NAMES["#cap"] } : {}), ...(calls === undefined ? {} : { "#n": NAMES["#n"] }) };
  const values: Record<string, unknown> = { ":org": orgId, ":est": estimate, ...(capped ? { ":limit": (target.capMicros) - estimate, ":cap": target.capMicros } : {}), ...(calls === undefined ? {} : { ":calls": calls.add, ":maxCalls": calls.max - calls.add }) };
  const conditions = ["(attribute_not_exists(#o) OR #o = :org)"];
  if (capped) conditions.push("attribute_not_exists(#ov)", "(attribute_not_exists(#c) OR #c <= :limit)");
  if (calls !== undefined) conditions.push("(attribute_not_exists(#n) OR #n <= :maxCalls)");
  return {
    Update: {
      TableName: deps.tableName,
      Key: target.key,
      UpdateExpression: `SET #o = :org${capped ? ", #cap = :cap" : ""} ADD #c :est, #r :est${calls === undefined ? "" : ", #n :calls"}`,
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

async function readItem(deps: ProductAiMeterDependencies, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
}

/** Which item refused, read again (a cancelled transaction says only which condition failed). Overrun wins over a plain cap; the task's call count is told apart from its dollars. */
async function classifyRefusal(deps: ProductAiMeterDependencies, items: readonly CappedKey[], failed: readonly number[], callsMax?: number): Promise<ProductAiReserveRefusal> {
  for (const index of failed) {
    const target = items[index];
    if (target === undefined) continue;
    const item = await readItem(deps, target.key);
    if (item?.overrun === true) return { ok: false, reason: "overrun", item: target.item };
    if (target.item === "task" && callsMax !== undefined && whole(item?.calls) && (item.calls) >= callsMax) return { ok: false, reason: "calls", item: "task" };
    return { ok: false, reason: "cap", item: target.item, ...(target.capMicros === undefined ? {} : { capMicros: target.capMicros }) };
  }
  return { ok: false, reason: "busy" };
}

const CONFLICT_RETRIES = 3;

async function transactReserve(deps: ProductAiMeterDependencies, items: readonly CappedKey[], updates: ReadonlyArray<ReturnType<typeof reserveUpdate>>, callsMax?: number): Promise<{ ok: true } | ProductAiReserveRefusal> {
  for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt += 1) {
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...updates] }));
      return { ok: true };
    } catch (error) {
      if (errorName(error) !== "TransactionCanceledException") throw error;
      const codes = reasons(error).map((reason) => reason.Code);
      const failed = codes.flatMap((code, index) => (code === "ConditionalCheckFailed" ? [index] : []));
      if (failed.length > 0) return classifyRefusal(deps, items, failed, callsMax);
      // A conflict with another transaction on the same items wrote nothing: the reservation (not a model call) may be tried again.
      if (!codes.includes("TransactionConflict")) throw error;
    }
  }
  return { ok: false, reason: "busy" };
}

/** Releases expired holds of a project before a new reservation reads its month (fork F5). */
async function sweepExpired(deps: ProductAiMeterDependencies, orgId: OrgId, project: string): Promise<void> {
  const index = productAiMeterKeys.holdIndex(orgId, project, "x");
  const page = (await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": index.pk }, ConsistentRead: true, Limit: 100 }))) as { Items?: Array<Record<string, unknown>> };
  const now = deps.now();
  for (const row of page.Items ?? []) {
    if (typeof row.sk === "string" && whole(row.expiresAtMs) && (row.expiresAtMs) < now) await closeHoldInternal(deps, row.sk, { orgId, project, onlyIfExpired: true });
  }
}

/**
 * Reserves `estimateMicros` for one call on the per-call path: the task, the project's month and the company's month, all or nothing. The task's call count goes up by one (its cap is `caps.taskCalls`).
 * `task` is undefined for a call with no task item (a scheduled run, TE-F11): only the months are reserved.
 */
export async function reserveProductAiCall(
  deps: ProductAiMeterDependencies,
  args: { readonly orgId: OrgId; readonly project: string; readonly taskId: string | undefined; readonly estimateMicros: number; readonly caps: ProductAiMeterCaps },
): Promise<{ readonly ok: true; readonly reservation: ProductAiReservation } | ProductAiReserveRefusal> {
  checkScope(args.orgId, args.project, args.taskId);
  checkCaps(args.caps);
  if (!whole(args.estimateMicros)) throw new RangeError("the estimate must be a whole number");
  await sweepExpired(deps, args.orgId, args.project);
  const month = meterMonthOf(deps.now());
  const items: CappedKey[] = [
    ...(args.taskId === undefined ? [] : [{ key: productAiMeterKeys.task(args.taskId), item: "task" as const, capMicros: args.caps.taskMicros }]),
    { key: productAiMeterKeys.project(args.orgId, args.project, month), item: "project", capMicros: args.caps.projectMonthMicros },
    { key: productAiMeterKeys.company(args.orgId, month), item: "company", capMicros: args.caps.companyMonthMicros },
  ];
  // A cap the estimate alone passes: refused with no write (the limit would be negative).
  for (const target of items) if (target.capMicros !== undefined && args.estimateMicros > target.capMicros) {
    const item = await readItem(deps, target.key);
    return item?.overrun === true ? { ok: false, reason: "overrun", item: target.item } : { ok: false, reason: "cap", item: target.item, capMicros: target.capMicros };
  }
  const updates = items.map((target) => reserveUpdate(deps, target, args.orgId, args.estimateMicros, target.item === "task" ? { add: 1, max: args.caps.taskCalls } : undefined));
  const result = await transactReserve(deps, items, updates, args.caps.taskCalls);
  if (!result.ok) return result;
  return { ok: true, reservation: { orgId: args.orgId, reserveMicros: args.estimateMicros, items } };
}

/** Marks every capped item whose SPEND is now above its cap (DEC 165). True when any is. */
async function markOverruns(deps: ProductAiMeterDependencies, items: readonly CappedKey[]): Promise<boolean> {
  let overrun = false;
  for (const target of items) {
    if (target.capMicros === undefined) continue;
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: target.key, UpdateExpression: "SET #ov = :t", ConditionExpression: "#s > :cap",
        ExpressionAttributeNames: { "#ov": NAMES["#ov"], "#s": NAMES["#s"] }, ExpressionAttributeValues: { ":t": true, ":cap": target.capMicros },
      }));
      overrun = true;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }
  return overrun;
}

/** Settles a reservation at `costMicros` (never refused). `overrun` is true when this settle took a capped item's spend past its cap: the next call on it is refused. */
export async function settleProductAiCall(deps: ProductAiMeterDependencies, reservation: ProductAiReservation, costMicros: number): Promise<{ readonly overrun: boolean }> {
  if (!whole(costMicros)) throw new RangeError("the cost must be a whole number");
  await deps.documentClient.send(new TransactWriteCommand({
    TransactItems: reservation.items.map((target) => ({
      Update: {
        TableName: deps.tableName, Key: target.key, UpdateExpression: "ADD #c :delta, #r :neg, #s :cost",
        ExpressionAttributeNames: { "#c": NAMES["#c"], "#r": NAMES["#r"], "#s": NAMES["#s"] },
        ExpressionAttributeValues: { ":delta": costMicros - reservation.reserveMicros, ":neg": -reservation.reserveMicros, ":cost": costMicros },
      },
    })),
  }));
  return { overrun: await markOverruns(deps, reservation.items) };
}

// ---- holds (forks F2, F3, F5, F8)

export type ProductAiHoldPurpose = "eval-hold" | "real-model-run";
export interface ProductAiHoldHandle { readonly holdId: string; readonly orgId: OrgId; readonly project: string }
export interface ProductAiHoldCall { readonly hold: ProductAiHoldHandle; readonly reserveMicros: number; readonly taskId: string | undefined; readonly month: string }

/**
 * Opens a hold of `amountMicros` and `maxCalls`: reserves the whole amount on the project and company months (and, for `real-model-run`, on the task item and `maxCalls` on its call count) together with the hold
 * item, all or nothing. An eval hold never touches the task's $2/200-call item (DEC 203). `deadlineMs` is the run's own deadline; the hold expires 15 minutes after it.
 */
export async function openProductAiHold(
  deps: ProductAiMeterDependencies,
  args: { readonly holdId: string; readonly orgId: OrgId; readonly project: string; readonly taskId?: string; readonly purpose: ProductAiHoldPurpose; readonly amountMicros: number; readonly maxCalls: number; readonly deadlineMs: number; readonly caps: ProductAiMeterCaps },
): Promise<{ readonly ok: true; readonly hold: ProductAiHoldHandle } | ProductAiReserveRefusal> {
  checkScope(args.orgId, args.project, args.taskId);
  checkCaps(args.caps);
  if (!ID.test(args.holdId) || !whole(args.amountMicros) || !whole(args.maxCalls) || args.maxCalls < 1 || !whole(args.deadlineMs)) throw new RangeError("not a usable hold");
  if (args.purpose === "real-model-run" && args.taskId === undefined) throw new RangeError("a real-model run's hold names its task");
  await sweepExpired(deps, args.orgId, args.project);
  const now = deps.now();
  const month = meterMonthOf(now);
  const expiresAtMs = args.deadlineMs + PRODUCT_AI_HOLD_GRACE_MS;
  const items: CappedKey[] = [
    { key: productAiMeterKeys.project(args.orgId, args.project, month), item: "project", capMicros: args.caps.projectMonthMicros },
    { key: productAiMeterKeys.company(args.orgId, month), item: "company", capMicros: args.caps.companyMonthMicros },
    ...(args.purpose === "real-model-run" ? [{ key: productAiMeterKeys.task(args.taskId as string), item: "task" as const, capMicros: args.caps.taskMicros }] : []),
  ];
  for (const target of items) if (target.capMicros !== undefined && args.amountMicros > target.capMicros) return { ok: false, reason: "cap", item: target.item, capMicros: target.capMicros };
  const holdKey = productAiMeterKeys.hold(args.holdId);
  const updates = [
    ...items.map((target) => reserveUpdate(deps, target, args.orgId, args.amountMicros, target.item === "task" ? { add: args.maxCalls, max: args.caps.taskCalls } : undefined)),
    { Put: { TableName: deps.tableName, Item: { ...holdKey, orgId: args.orgId, project: args.project, ...(args.taskId === undefined ? {} : { taskId: args.taskId }), purpose: args.purpose, amountMicros: args.amountMicros, maxCalls: args.maxCalls, committed: 0, headroom: args.amountMicros, spentMicros: 0, reservedMicros: 0, calls: 0, state: "open", month, expiresAtMs }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: deps.tableName, Item: { ...productAiMeterKeys.holdIndex(args.orgId, args.project, args.holdId), expiresAtMs } } },
  ];
  const result = await transactReserve(deps, items, updates as never, args.caps.taskCalls);
  if (!result.ok) return result;
  return { ok: true, hold: { holdId: args.holdId, orgId: args.orgId, project: args.project } };
}

/** One call inside a hold: reserves on the hold item only, and only while the hold is open, unexpired, not overrun, the scope's own, and the amount and call count still hold it. */
export async function reserveInProductAiHold(deps: ProductAiMeterDependencies, hold: ProductAiHoldHandle, estimateMicros: number): Promise<{ readonly ok: true; readonly call: ProductAiHoldCall } | ProductAiReserveRefusal> {
  if (!whole(estimateMicros)) throw new RangeError("the estimate must be a whole number");
  const key = productAiMeterKeys.hold(hold.holdId);
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key,
      // DynamoDB conditions cannot subtract: the hold keeps `headroom` = amount - spent - reserved, and a call needs headroom >= its estimate.
      UpdateExpression: "ADD #c :est, #r :est, #n :one, #h :negEst",
      ConditionExpression: "#o = :org AND #p = :project AND #st = :open AND #e > :now AND attribute_not_exists(#ov) AND #h >= :est AND #n < #mc",
      ExpressionAttributeNames: { "#o": "orgId", "#p": "project", "#st": "state", "#e": "expiresAtMs", "#ov": "overrun", "#c": "committed", "#r": "reservedMicros", "#n": "calls", "#h": "headroom", "#mc": "maxCalls" },
      ExpressionAttributeValues: { ":org": hold.orgId, ":project": hold.project, ":open": "open", ":now": deps.now(), ":est": estimateMicros, ":negEst": -estimateMicros, ":one": 1 },
    }));
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    const item = await readItem(deps, key);
    return item?.overrun === true ? { ok: false, reason: "overrun", item: "hold" } : { ok: false, reason: "cap", item: "hold" };
  }
  const item = await readItem(deps, key);
  return { ok: true, call: { hold, reserveMicros: estimateMicros, taskId: typeof item?.taskId === "string" ? item.taskId : undefined, month: String(item?.month) } };
}

/** Settles one call in a hold (never refused): the hold's reservation becomes the true cost; the months (and the task for a real-model run) record the spend. A spend past the amount marks the hold overrun. */
export async function settleInProductAiHold(deps: ProductAiMeterDependencies, call: ProductAiHoldCall, costMicros: number): Promise<{ readonly overrun: boolean }> {
  if (!whole(costMicros)) throw new RangeError("the cost must be a whole number");
  const spendOn = (key: { pk: string; sk: string }) => ({ Update: { TableName: deps.tableName, Key: key, UpdateExpression: "ADD #s :cost", ExpressionAttributeNames: { "#s": NAMES["#s"] }, ExpressionAttributeValues: { ":cost": costMicros } } });
  try {
    await deps.documentClient.send(new TransactWriteCommand({
    TransactItems: [
      // Only while the hold is open (REVIEW-1 L-6): a call that settles after close was already counted by close (its reservation was kept as spent), so it is not counted again.
      { Update: { TableName: deps.tableName, Key: productAiMeterKeys.hold(call.hold.holdId), UpdateExpression: "ADD #c :delta, #r :neg, #s :cost, #h :back", ConditionExpression: "#st = :open", ExpressionAttributeNames: { "#c": NAMES["#c"], "#r": NAMES["#r"], "#s": NAMES["#s"], "#h": "headroom", "#st": "state" }, ExpressionAttributeValues: { ":delta": costMicros - call.reserveMicros, ":neg": -call.reserveMicros, ":cost": costMicros, ":back": call.reserveMicros - costMicros, ":open": "open" } } },
      spendOn(productAiMeterKeys.project(call.hold.orgId, call.hold.project, call.month)),
      spendOn(productAiMeterKeys.company(call.hold.orgId, call.month)),
      ...(call.taskId === undefined ? [] : [spendOn(productAiMeterKeys.task(call.taskId))]),
    ],
    }));
  } catch (error) {
    if (errorName(error) === "TransactionCanceledException") return { overrun: false };
    throw error;
  }
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: productAiMeterKeys.hold(call.hold.holdId), UpdateExpression: "SET #ov = :t", ConditionExpression: "#s > #amt",
      ExpressionAttributeNames: { "#ov": "overrun", "#s": NAMES["#s"], "#amt": "amountMicros" }, ExpressionAttributeValues: { ":t": true },
    }));
    return { overrun: true };
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    return { overrun: false };
  }
}

async function closeHoldInternal(deps: ProductAiMeterDependencies, holdId: string, scope: { readonly orgId: OrgId; readonly project: string; readonly onlyIfExpired: boolean }): Promise<boolean> {
  const key = productAiMeterKeys.hold(holdId);
  const item = await readItem(deps, key);
  if (item === undefined || item.state !== "open" || item.orgId !== scope.orgId || item.project !== scope.project) return false;
  const amount = item.amountMicros as number;
  const spent = item.spentMicros as number;
  // A reservation whose call never settled (a crash, a fault mid-call) is kept: its usage is uncertain, so it counts as spent.
  const kept = Math.max(0, item.reservedMicros as number);
  const final = spent + kept;
  const month = String(item.month);
  const release = (target: { pk: string; sk: string }) => ({ Update: { TableName: deps.tableName, Key: target, UpdateExpression: "ADD #c :delta, #r :neg, #s :kept", ExpressionAttributeNames: { "#c": NAMES["#c"], "#r": NAMES["#r"], "#s": NAMES["#s"] }, ExpressionAttributeValues: { ":delta": final - amount, ":neg": -amount, ":kept": kept } } });
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: deps.tableName, Key: key, UpdateExpression: "SET #st = :closed",
            ConditionExpression: scope.onlyIfExpired ? "#st = :open AND #e < :now AND #s = :spent AND #r = :reserved" : "#st = :open AND #s = :spent AND #r = :reserved",
            ExpressionAttributeNames: { "#st": "state", "#s": NAMES["#s"], "#r": NAMES["#r"], ...(scope.onlyIfExpired ? { "#e": "expiresAtMs" } : {}) },
            ExpressionAttributeValues: { ":closed": "closed", ":open": "open", ":spent": spent, ":reserved": item.reservedMicros, ...(scope.onlyIfExpired ? { ":now": deps.now() } : {}) },
          },
        },
        release(productAiMeterKeys.project(scope.orgId, scope.project, month)),
        release(productAiMeterKeys.company(scope.orgId, month)),
        ...(item.purpose === "real-model-run" && typeof item.taskId === "string" ? [release(productAiMeterKeys.task(item.taskId))] : []),
        { Delete: { TableName: deps.tableName, Key: productAiMeterKeys.holdIndex(scope.orgId, scope.project, holdId) } },
      ],
    }));
    return true;
  } catch (error) {
    // Closed by someone else, or a call settled in between: nothing was written.
    if (errorName(error) === "TransactionCanceledException") return false;
    throw error;
  }
}

/** Closes a hold: releases what it did not spend, keeps what is uncertain. False when it was not open (or not this scope's). */
export async function closeProductAiHold(deps: ProductAiMeterDependencies, hold: ProductAiHoldHandle): Promise<boolean> {
  return closeHoldInternal(deps, hold.holdId, { orgId: hold.orgId, project: hold.project, onlyIfExpired: false });
}

/** Whether a State stream record's key is one of the meter's (the stream consumers skip them). */
export const isProductAiMeterKey = (pk: unknown): boolean => typeof pk === "string" && pk.startsWith(PRODUCT_AI_METER_PREFIX);
