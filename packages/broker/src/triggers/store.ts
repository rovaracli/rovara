// The trigger store (Plan 4 Task 18): a trigger's record, the index items that find it (by target, by creator, by the hook that receives its events, and the org's
// directory), what it did (activity, which expires) and the notices stored for the people who should hear of it. Every multi-item write is one transaction, written with
// the request item (R18) when the request has one, so a repeat is answered from it and writes nothing. A write that depends on what it read is conditional on the
// record's `revision`: a lost race is a conflict, never an overwrite.
import { DeleteCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { EventTriggerSpecSchema, INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, MAX_TRIGGERS_PER_TARGET, ScheduleTriggerSpecSchema, TriggerTargetSchema, TRIGGER_ACTIVITY_TTL_DAYS, newPrefixedId, orgScoped, pendingTriggerScheduleKey, targetTriggerCountKey, targetTriggersKey, triggerActivityKey, triggerKey, triggerMatchKey, triggerNoticeKey, triggerTargetKey, triggersByCreatorKey, type EventTriggerSpec, type OrgId, type OrgKey, type ScheduleTriggerSpec, type TriggerOutcome, type TriggerTarget } from "@rovara-code/contracts";
import { coded, commit, strip, transact, withoutUndefined, type Item, type RequestMark, type TableInput, type TransactItem } from "../agents/table-writes.js";

export type TriggerSpec = EventTriggerSpec | ScheduleTriggerSpec;

/** A trigger as stored. `revision` counts its writes, for the writes that depend on what they read. */
export interface TriggerRecord {
  orgId: OrgId;
  triggerId: string;
  target: TriggerTarget;
  project: string;
  spec: TriggerSpec;
  /** The hook that receives the events of a non-GitHub event trigger. */
  hookId?: string;
  enabled: boolean;
  disabledReason?: string;
  maxRunsPerHour: number;
  /** A schedule trigger's schedule: `ok` once the scheduler has it, `pending` until it does (Task 26 repairs one that is pending). */
  scheduleStatus?: "ok" | "pending";
  lastFiredAt?: string;
  /** Set when the trigger starts work, so the no-overlap check (Task 26) can read the open run or task. */
  lastRunId?: string;
  lastTaskId?: string;
  /**
   * A schedule slot's start under way (Task 26 review M-1): written with a conditional update on the revision before the work is started, so two fires that both saw no open work
   * cannot both start; the update that notes the started work takes it away. Another slot treats a fresh one as open work; a stale one (a start cut short) is ignored.
   */
  startClaim?: { slot: string; at: string };
  /** The one request to turn this trigger on that may still be confirmed (a newer request, a turn-off or a change of spec closes it). */
  pendingApprovalId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/**
 * What a stored trigger must hold to be acted on. The lists parse with it, so a record that was damaged or written by something else is left out (and reported to a caller that asks)
 * instead of failing the read of every other trigger beside it. Fields it does not name are kept.
 */
const TriggerRecordSchema = z.object({
  orgId: z.string().min(1),
  triggerId: z.string().min(1),
  target: TriggerTargetSchema,
  project: z.string().min(1),
  spec: z.union([EventTriggerSpecSchema, ScheduleTriggerSpecSchema]),
  hookId: z.string().optional(),
  enabled: z.boolean(),
  maxRunsPerHour: z.number(),
  createdBy: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string(),
  revision: z.number(),
}).passthrough();

export interface TriggerActivityEntry {
  at: string;
  eventKey: string;
  outcome: TriggerOutcome;
  runId?: string;
  taskId?: string;
  reason?: string;
}

/** A notice for a member, kept for the app to show and Slack to post. */
export interface TriggerNotice {
  at: string;
  triggerId: string;
  developerId: string;
  text: string;
}

export interface TriggerStoreInput extends TableInput {
  newId?: () => string;
}

type Request = { request?: RequestMark; result?: unknown };

const CONFLICT_TEXT = "Someone else changed this trigger just now. Reload it and make your change again.";
const conflict = () => coded("CONFIG_INVALID", CONFLICT_TEXT);
/** Whether `error` is the store saying the trigger moved since it was read: the write is to be made again from a fresh read. */
export const isTriggerConflict = (error: unknown): boolean => (error as { code?: unknown; message?: unknown } | null)?.code === "CONFIG_INVALID" && String((error as { message?: unknown }).message).includes(CONFLICT_TEXT);

/** The fields of a record a change may take away. */
export type ClearableField = "hookId" | "disabledReason" | "scheduleStatus" | "lastFiredAt" | "lastRunId" | "lastTaskId" | "startClaim" | "pendingApprovalId";
const full = (what: string) => coded("CONFIG_INVALID", `${what} already has the most triggers it can have (${String(MAX_TRIGGERS_PER_TARGET)}). Remove one first.`);
const NOT_EXISTS = "attribute_not_exists(pk)";
const DAY_SECONDS = 86_400;

const isPending = (record: Pick<TriggerRecord, "spec" | "scheduleStatus">): boolean => record.spec.kind === "schedule" && record.scheduleStatus === "pending";

/** The hook segment of a trigger's match key: the hook's id, or `github` for the events GitHub's app delivers (they have none). */
export const hookSegmentOf = (record: Pick<TriggerRecord, "hookId">): string => record.hookId ?? "github";

/** The directory of an org's triggers, for closing it. */
const directoryKey = (orgId: OrgId, triggerId: string): OrgKey => ({ pk: orgScoped(orgId, "TRIGGERS"), sk: triggerId });
const recipientKey = (orgId: OrgId, developerId: string): OrgKey => ({ pk: orgScoped(orgId, "TRIGGER_NOTICE_RECIPIENTS"), sk: developerId });

export class TriggerStore {
  private readonly newId: () => string;

  constructor(private readonly input: TriggerStoreInput) {
    this.newId = input.newId ?? (() => newPrefixedId("ctr"));
  }

  newTriggerId(): string {
    return this.newId();
  }

  private iso(): string {
    return new Date(this.input.now()).toISOString();
  }

  // ---- reads

  private async read(key: OrgKey): Promise<Item | undefined> {
    return (await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
  }

  private async queryAll(pk: string, options: { skPrefix?: string; limit?: number; descending?: boolean } = {}): Promise<Item[]> {
    const found: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.input.documentClient.send(new QueryCommand({
        TableName: this.input.tableName,
        KeyConditionExpression: options.skPrefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: options.skPrefix === undefined ? { ":pk": pk } : { ":pk": pk, ":prefix": options.skPrefix },
        ConsistentRead: true,
        ...(options.descending === true ? { ScanIndexForward: false } : {}),
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
      found.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
      if (options.limit !== undefined && found.length >= options.limit) return found.slice(0, options.limit);
    } while (start !== undefined);
    return found;
  }

  /** The trigger, read under `orgId` (a trigger of another org is none). */
  async get(orgId: OrgId, triggerId: string): Promise<TriggerRecord | undefined> {
    const item = await this.read(triggerKey(orgId, triggerId));
    return item === undefined || item["orgId"] !== orgId ? undefined : (strip(item) as unknown as TriggerRecord);
  }

  /**
   * The records the index names, oldest first. One that is not there (or is another org's) is left out; one that does not parse is left out too and handed to `onUnreadable`
   * by its id, so a caller that can log does.
   */
  private async recordsOf(orgId: OrgId, index: Item[], onUnreadable?: (triggerId: string) => void): Promise<TriggerRecord[]> {
    const found = await Promise.all(index.map(async (entry) => {
      const triggerId = String(entry["sk"]);
      return { triggerId, item: await this.read(triggerKey(orgId, triggerId)) };
    }));
    const records: TriggerRecord[] = [];
    for (const { triggerId, item } of found) {
      if (item === undefined || item["orgId"] !== orgId) continue;
      const parsed = TriggerRecordSchema.safeParse(strip(item));
      if (parsed.success) records.push(parsed.data as unknown as TriggerRecord);
      else onUnreadable?.(triggerId);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.triggerId.localeCompare(b.triggerId));
  }

  async listForTarget(orgId: OrgId, target: TriggerTarget): Promise<TriggerRecord[]> {
    return this.recordsOf(orgId, await this.queryAll(targetTriggersKey(orgId, triggerTargetKey(target), "x").pk, { skPrefix: "ctr_" }));
  }

  async listByCreator(orgId: OrgId, developerId: string): Promise<TriggerRecord[]> {
    return this.recordsOf(orgId, await this.queryAll(triggersByCreatorKey(orgId, developerId, "x").pk));
  }

  /** The triggers of the receiving hook (`hookId` undefined for GitHub's): what dispatch reads, and no other hook's. */
  async listForMatch(orgId: OrgId, source: EventTriggerSpec["source"], project: string, hookId: string | undefined, onUnreadable?: (triggerId: string) => void): Promise<TriggerRecord[]> {
    return this.recordsOf(orgId, await this.queryAll(triggerMatchKey(orgId, source, project, hookId ?? "github", "x").pk), onUnreadable);
  }

  /** Every trigger of the org, from its directory. */
  async listAll(orgId: OrgId): Promise<TriggerRecord[]> {
    return this.recordsOf(orgId, await this.queryAll(directoryKey(orgId, "x").pk));
  }

  /** The triggers (org and id) whose schedule is still pending, from the global list, at most `limit`. Nothing is read from a trigger here: the list names it and the reader reads it under its org. */
  async listPendingSchedules(limit: number): Promise<Array<{ orgId: OrgId; triggerId: string }>> {
    const found: Array<{ orgId: OrgId; triggerId: string }> = [];
    for (const item of await this.queryAll(pendingTriggerScheduleKey(OrgIdSchema.parse("org_00000000000000000000"), "x").pk, { limit })) {
      const org = OrgIdSchema.safeParse(item["orgId"]);
      const triggerId = String(item["triggerId"]);
      if (org.success && String(item["sk"]) === `${org.data}#${triggerId}`) found.push({ orgId: org.data, triggerId });
    }
    return found;
  }

  /** Takes a trigger off the pending list without touching its record (the list names a trigger that is gone). */
  async dropPending(orgId: OrgId, triggerId: string): Promise<void> {
    await this.sweep(pendingTriggerScheduleKey(orgId, triggerId));
  }

  /** The newest `limit` items of a trigger's activity, newest first. */
  async listActivity(orgId: OrgId, triggerId: string, limit = 100): Promise<TriggerActivityEntry[]> {
    const items = await this.queryAll(triggerActivityKey(orgId, triggerId, "2000-01-01T00:00:00.000Z", "x").pk, { limit, descending: true });
    return items.map((item) => strip(item) as unknown as TriggerActivityEntry);
  }

  async listNotices(orgId: OrgId, developerId: string): Promise<TriggerNotice[]> {
    const items = await this.queryAll(triggerNoticeKey(orgId, developerId, "2000-01-01T00:00:00.000Z", "x").pk);
    return items.map((item) => strip(item) as unknown as TriggerNotice);
  }

  // ---- item builders (a caller adds them to the transaction of the change they belong to)

  private put(key: OrgKey, entityType: string, fields: Item, condition?: string): TransactItem {
    return { Put: { TableName: this.input.tableName, Item: { ...key, entityType, ...withoutUndefined(fields) }, ...(condition === undefined ? {} : { ConditionExpression: condition }) } };
  }

  private remove(key: OrgKey): TransactItem {
    return { Delete: { TableName: this.input.tableName, Key: key } };
  }

  /** What the counter of a target's triggers does: `+1` held to the most a target may have, or `-1` while there is one. */
  private count(orgId: OrgId, target: TriggerTarget, delta: 1 | -1): TransactItem {
    return {
      Update: {
        TableName: this.input.tableName,
        Key: targetTriggerCountKey(orgId, triggerTargetKey(target)),
        UpdateExpression: "SET #c = if_not_exists(#c, :zero) + :delta",
        ConditionExpression: delta === 1 ? "attribute_not_exists(#c) OR #c < :max" : "attribute_exists(#c) AND #c >= :one",
        ExpressionAttributeNames: { "#c": "count" },
        ExpressionAttributeValues: delta === 1 ? { ":zero": 0, ":delta": 1, ":max": MAX_TRIGGERS_PER_TARGET } : { ":zero": 0, ":delta": -1, ":one": 1 },
      },
    };
  }

  /** The index items of a record: its place under its target, its creator, the org's directory and, for an event trigger, the hook that receives its events. */
  private indexItems(record: TriggerRecord): TransactItem[] {
    const { orgId, triggerId } = record;
    const items: TransactItem[] = [
      this.put(targetTriggersKey(orgId, triggerTargetKey(record.target), triggerId), "TARGET_TRIGGER", { orgId, triggerId }),
      this.put(triggersByCreatorKey(orgId, record.createdBy, triggerId), "TRIGGER_BY_CREATOR", { orgId, triggerId }),
      this.put(directoryKey(orgId, triggerId), "TRIGGER_DIRECTORY", { orgId, triggerId }),
    ];
    if (record.spec.kind === "event") items.push(this.put(triggerMatchKey(orgId, record.spec.source, record.project, hookSegmentOf(record), triggerId), "TRIGGER_MATCH", { orgId, triggerId, enabled: record.enabled }));
    if (isPending(record)) items.push(this.put(pendingTriggerScheduleKey(orgId, triggerId), "TRIGGER_SCHEDULE_PENDING", { orgId, triggerId }));
    return items;
  }

  private removeIndexItems(record: TriggerRecord): TransactItem[] {
    const { orgId, triggerId } = record;
    const items: TransactItem[] = [
      this.remove(targetTriggersKey(orgId, triggerTargetKey(record.target), triggerId)),
      this.remove(triggersByCreatorKey(orgId, record.createdBy, triggerId)),
      this.remove(directoryKey(orgId, triggerId)),
    ];
    if (record.spec.kind === "event") items.push(this.remove(triggerMatchKey(orgId, record.spec.source, record.project, hookSegmentOf(record), triggerId)));
    if (record.spec.kind === "schedule") items.push(this.remove(pendingTriggerScheduleKey(orgId, triggerId)));
    return items;
  }

  /** One thing the trigger did or was told, to add to a transaction. It expires with `TRIGGER_ACTIVITY_TTL_DAYS`. */
  activityItem(orgId: OrgId, triggerId: string, entry: Omit<TriggerActivityEntry, "at"> & { at?: string }): TransactItem {
    const at = entry.at ?? this.iso();
    return this.put(triggerActivityKey(orgId, triggerId, at, entry.eventKey), "TRIGGER_ACTIVITY", {
      orgId, triggerId, ...entry, at: new Date(at).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(this.input.now() / 1000) + TRIGGER_ACTIVITY_TTL_DAYS * DAY_SECONDS,
    });
  }

  /** A notice for `developerId` and the item that lists them as a recipient (so closing the org finds it), to add to a transaction. */
  noticeItems(orgId: OrgId, triggerId: string, developerId: string, text: string): TransactItem[] {
    const at = this.iso();
    return [
      this.put(triggerNoticeKey(orgId, developerId, at, triggerId), "TRIGGER_NOTICE", { orgId, triggerId, developerId, text, at }),
      this.put(recipientKey(orgId, developerId), "TRIGGER_NOTICE_RECIPIENT", { orgId, developerId }),
    ];
  }

  // ---- writes

  /** Stores a new trigger with its index items. A target already at the most it may have refuses it. */
  async create(input: Request & { record: Omit<TriggerRecord, "revision" | "createdAt" | "updatedAt"> & { createdAt?: string }; extra?: TransactItem[] }): Promise<TriggerRecord> {
    const now = this.iso();
    const record: TriggerRecord = { ...input.record, createdAt: input.record.createdAt ?? now, updatedAt: now, revision: 1 };
    const index = this.indexItems(record);
    await commit(this.input, [
      this.put(triggerKey(record.orgId, record.triggerId), "TRIGGER", record as unknown as Item, NOT_EXISTS),
      this.count(record.orgId, record.target, 1),
      ...index, ...(input.extra ?? []),
    ], (failed) => (failed.has(0) ? conflict() : failed.has(1) ? full("this chain or agent") : undefined), input.request, input.result ?? record);
    return record;
  }

  /**
   * Changes the fields in `patch` (and takes away those in `clear`) of a trigger, while it is still at `trigger.revision`; `revision` and `updatedAt` are the store's. A
   * change of target, creator, project, source or hook moves the index items in the same transaction. `extra` joins the transaction (activity, notices).
   */
  async update(input: Request & { trigger: TriggerRecord; patch: Partial<Omit<TriggerRecord, "orgId" | "triggerId" | "revision" | "updatedAt">>; clear?: ClearableField[]; extra?: TransactItem[]; refuse?: (failed: Set<number>) => Error | undefined }): Promise<TriggerRecord> {
    const before = input.trigger;
    const after: TriggerRecord = { ...before, ...input.patch, revision: before.revision + 1, updatedAt: this.iso() };
    for (const field of input.clear ?? []) delete after[field];
    const targetMoved = triggerTargetKey(before.target) !== triggerTargetKey(after.target);
    const creatorMoved = before.createdBy !== after.createdBy;
    const matchBefore = before.spec.kind === "event" ? triggerMatchKey(before.orgId, before.spec.source, before.project, hookSegmentOf(before), before.triggerId) : undefined;
    const matchAfter = after.spec.kind === "event" ? triggerMatchKey(after.orgId, after.spec.source, after.project, hookSegmentOf(after), after.triggerId) : undefined;
    const items: TransactItem[] = [{
      Put: { TableName: this.input.tableName, Item: { ...triggerKey(after.orgId, after.triggerId), entityType: "TRIGGER", ...withoutUndefined(after as unknown as Item) }, ConditionExpression: "revision = :revision", ExpressionAttributeValues: { ":revision": before.revision } },
    }];
    let newCount: number | undefined;
    if (targetMoved) {
      items.push(this.count(before.orgId, before.target, -1), this.remove(targetTriggersKey(before.orgId, triggerTargetKey(before.target), before.triggerId)));
      newCount = items.length;
      items.push(this.count(after.orgId, after.target, 1), this.put(targetTriggersKey(after.orgId, triggerTargetKey(after.target), after.triggerId), "TARGET_TRIGGER", { orgId: after.orgId, triggerId: after.triggerId }));
    }
    if (creatorMoved) {
      items.push(this.remove(triggersByCreatorKey(before.orgId, before.createdBy, before.triggerId)), this.put(triggersByCreatorKey(after.orgId, after.createdBy, after.triggerId), "TRIGGER_BY_CREATOR", { orgId: after.orgId, triggerId: after.triggerId }));
    }
    if (matchBefore !== undefined && (matchAfter === undefined || matchBefore.pk !== matchAfter.pk)) items.push(this.remove(matchBefore));
    if (matchAfter !== undefined) items.push(this.put(matchAfter, "TRIGGER_MATCH", { orgId: after.orgId, triggerId: after.triggerId, enabled: after.enabled }));
    // The sweep that repairs schedules finds the ones still pending through this list: it holds exactly the triggers whose record says so.
    if (isPending(after) && !isPending(before)) items.push(this.put(pendingTriggerScheduleKey(after.orgId, after.triggerId), "TRIGGER_SCHEDULE_PENDING", { orgId: after.orgId, triggerId: after.triggerId }));
    else if (!isPending(after) && isPending(before)) items.push(this.remove(pendingTriggerScheduleKey(before.orgId, before.triggerId)));
    items.push(...(input.extra ?? []));
    await commit(this.input, items, (failed) => {
      if (failed.has(0)) return conflict();
      if (newCount !== undefined && failed.has(newCount)) return full("the chain or agent you are moving it to");
      return input.refuse?.(failed);
    }, input.request, input.result ?? after);
    return after;
  }

  /** Deletes a trigger and its index items (its activity expires on its own). */
  async delete(input: Request & { trigger: TriggerRecord; extra?: TransactItem[] }): Promise<void> {
    const { trigger } = input;
    await commit(this.input, [
      { Delete: { TableName: this.input.tableName, Key: triggerKey(trigger.orgId, trigger.triggerId), ConditionExpression: "revision = :revision", ExpressionAttributeValues: { ":revision": trigger.revision } } },
      this.count(trigger.orgId, trigger.target, -1),
      ...this.removeIndexItems(trigger),
      ...(input.extra ?? []),
    ], (failed) => (failed.has(0) || failed.has(1) ? conflict() : undefined), input.request, input.result ?? { deleted: true });
  }

  /** Records one thing a trigger did, on its own (dispatch and the scheduler write it with the run they started, through `activityItem`). */
  async recordActivity(orgId: OrgId, triggerId: string, entry: Omit<TriggerActivityEntry, "at"> & { at?: string }): Promise<void> {
    await transact(this.input, [this.activityItem(orgId, triggerId, entry)], () => undefined);
  }

  /**
   * Deletes everything of an org's: its triggers, their index items, their activity and the notices of the people who were told. Repeatable: closing an org again
   * finishes what a failed close left. Another org's items are not named by any key built here.
   */
  async deleteOrg(orgId: OrgId): Promise<{ triggers: number }> {
    const triggers = await this.listAll(orgId);
    for (const trigger of triggers) {
      for (const entry of await this.queryAll(triggerActivityKey(orgId, trigger.triggerId, "2000-01-01T00:00:00.000Z", "x").pk)) await this.sweep({ pk: String(entry["pk"]), sk: String(entry["sk"]) });
      for (const item of this.removeIndexItems(trigger)) if (item.Delete !== undefined) await this.sweep(item.Delete.Key as OrgKey);
      await this.sweep(targetTriggerCountKey(orgId, triggerTargetKey(trigger.target)));
      await this.sweep(triggerKey(orgId, trigger.triggerId));
    }
    for (const recipient of await this.queryAll(recipientKey(orgId, "x").pk)) {
      const developerId = String(recipient["sk"]);
      for (const notice of await this.queryAll(triggerNoticeKey(orgId, developerId, "2000-01-01T00:00:00.000Z", "x").pk)) await this.sweep({ pk: String(notice["pk"]), sk: String(notice["sk"]) });
      await this.sweep(recipientKey(orgId, developerId));
    }
    return { triggers: triggers.length };
  }

  private async sweep(key: OrgKey): Promise<void> {
    await this.input.documentClient.send(new DeleteCommand({ TableName: this.input.tableName, Key: key }));
  }
}
