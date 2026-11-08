// Learning v2 wiring (LR-W3): where the tier-0 setting (read only since lessons connect fix 1: its change flow and proposals were deleted) and the preset and sole-owner switch with their proposals are stored, on the TeamRecord table, and the settings reader the learning lane reads through.
//   project: pk of the project, sk `LESSONSET#SETTINGS`      (`tier0`: the project's tier0Approval)
//   company: pk of the workspace, sk `LESSONSET#COMPANY`      (`tier0`: the company floor, companyApproval.tier0)
//   proposals (preset and sole-owner switch only): the same pk, sk `LESSONSET#TIER0CHG#PRESET#<id>` and `LESSONSET#TIER0CHG#SOLE#<id>`
//   company sole-owner switch: the workspace pk, sk `LESSONSET#COMPANYSOLE` (`enabled`: whether the sole-owner exception may approve a loosening; absent means ON). It holds no person.
// Every sort key starts with `LESSONSET`, which the project erase and the workspace erase already wipe.
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LEARNED_CONTEXT_MAX_BYTES, LEARNED_CONTEXT_MAX_LESSONS, LEARNING_MODE_DEFAULT, learningModeKey, learningModeLockKey, teamRecordPk } from "@agentx/contracts";
import type { TransactItem } from "../audit/outbox.js";
import { errorName, type Item } from "../agents/table-writes.js";
import type { TeamRecordTable } from "../team-record/types.js";
import { LOAD_BUDGET_MIN, TIER0_APPROVAL_DEFAULT, type LearningPreset, type LearningSettings, type LearningSettingsReader, type LoadBudgetSetting } from "./policy.js";
import type { PresetChange, PresetChangeStore, PresetScope, PresetStore } from "./preset-setting.js";
import type { SoleOwnerSwitchChange, SoleOwnerSwitchStore, Tier0Fence, Tier0Level, Tier0Scope, Tier0SettingsStore } from "./sole-owner-switch.js";

const pkOf = (scope: Tier0Scope): string => teamRecordPk(scope.workspaceId, scope.kind === "project" ? scope.project : undefined);
const settingKey = (scope: Tier0Scope) => ({ pk: pkOf(scope), sk: scope.kind === "project" ? "LESSONSET#SETTINGS" : "LESSONSET#COMPANY" });
const SOLE_OWNER_SK = "LESSONSET#COMPANYSOLE";
// The switch's proposals live under the tier-0 proposals' prefix on purpose: the person erase already replaces `proposedBy` on every row under it.
const SOLE_CHANGE_PREFIX = "LESSONSET#TIER0CHG#SOLE#";
const soleChangeKey = (workspaceId: string, id: string) => ({ pk: teamRecordPk(workspaceId, undefined), sk: `${SOLE_CHANGE_PREFIX}${id.replace(/#/gu, "_")}` });
const isLevel = (value: unknown): value is Tier0Level => value === "auto" || value === "one" || value === "two";
/** The contracts' mode names (lower case) and the policy's (capitalised). */
type Mode = NonNullable<LearningSettings["mode"]>;
const MODE_NAMES: Record<string, Mode> = { off: "Off", collect: "Collect", suggest: "Suggest", on: "On" };

export class DynamoTier0Settings implements Tier0SettingsStore {
  constructor(private readonly table: TeamRecordTable) {}

  private async item(key: { pk: string; sk: string }): Promise<Item | undefined> {
    return (await this.table.documentClient.send(new GetCommand({ TableName: this.table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
  }

  async read(scope: Tier0Scope): Promise<Tier0Level | undefined> {
    const item = await this.item(settingKey(scope));
    // A stored value that is not one of the three is not "unset" (which means the default): the call fails, and the caller fails closed.
    if (item === undefined) return undefined;
    if (!isLevel(item.tier0)) throw new Error("the stored tier-0 setting is not valid");
    return item.tier0;
  }

  async write(scope: Tier0Scope, value: Tier0Level, meta: { by: string; at: number }, from: Tier0Level, fence?: Tier0Fence): Promise<boolean> {
    // Conditional on the value the caller read; an absent item is the default, so it matches only when `from` is the default.
    const isDefault = from === (scope.kind === "project" ? TIER0_APPROVAL_DEFAULT : "auto");
    const put = {
      TableName: this.table.tableName, Item: { ...settingKey(scope), entityType: "LESSON_SETTINGS", tier0: value, updatedBy: meta.by, updatedAt: meta.at },
      ConditionExpression: isDefault ? "attribute_not_exists(pk) OR #t = :from" : "#t = :from", ExpressionAttributeNames: { "#t": "tier0" }, ExpressionAttributeValues: { ":from": from },
    };
    try {
      // With a fence the setting and the membership conditions commit together: one change in who may approve, and nothing is written.
      if (fence?.conditions !== undefined && fence.conditions.length > 0) {
        await this.table.documentClient.send(new TransactWriteCommand({ TransactItems: [...(fence.conditions as TransactItem[]), { Put: put }] }));
      } else {
        await this.table.documentClient.send(new PutCommand(put));
      }
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException" || errorName(error) === "TransactionCanceledException") return false;
      throw error;
    }
  }
}

const presetKey = (scope: PresetScope) => ({ pk: pkOf(scope), sk: scope.kind === "project" ? "LESSONSET#PRESET" : "LESSONSET#COMPANYPRESET" });
// Proposals to loosen a preset live under the tier-0 proposals' prefix on purpose: the person erase already replaces `proposedBy` on every row under it. The tier-0 reader skips them (another entity type).
const PRESET_CHANGE_PREFIX = "LESSONSET#TIER0CHG#PRESET#";
const presetChangeKey = (scope: PresetScope, id: string) => ({ pk: pkOf(scope), sk: `${PRESET_CHANGE_PREFIX}${id.replace(/#/gu, "_")}` });
const isPreset = (value: unknown): value is LearningPreset => value === "standard" || value === "regulated";
/** The learning preset (Standard / Regulated) of a project or the company, on items of their own so a tier-0 write never replaces it, and its loosening proposals. The setting item names no person. */
export class DynamoPresetStore implements PresetStore, PresetChangeStore {
  constructor(private readonly table: TeamRecordTable) {}
  private async item(key: { pk: string; sk: string }): Promise<Item | undefined> {
    return (await this.table.documentClient.send(new GetCommand({ TableName: this.table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
  }
  async read(scope: PresetScope): Promise<LearningPreset | undefined> {
    const item = await this.item(presetKey(scope));
    if (item === undefined) return undefined;
    if (!isPreset(item.preset)) throw new Error("the stored learning preset is not valid");
    return item.preset;
  }
  async write(scope: PresetScope, value: LearningPreset, meta: { by: string; at: number }, from: LearningPreset, fence?: Tier0Fence): Promise<boolean> {
    // Conditional on the value the caller read; an absent item is Standard, so it matches only when `from` is Standard. The item holds no person (the audit event names who).
    const put = {
      TableName: this.table.tableName, Item: { ...presetKey(scope), entityType: "LESSON_PRESET", preset: value, updatedAt: meta.at },
      ConditionExpression: from === "standard" ? "attribute_not_exists(pk) OR #p = :from" : "#p = :from", ExpressionAttributeNames: { "#p": "preset" }, ExpressionAttributeValues: { ":from": from },
    };
    try {
      if (fence?.conditions !== undefined && fence.conditions.length > 0) await this.table.documentClient.send(new TransactWriteCommand({ TransactItems: [...(fence.conditions as TransactItem[]), { Put: put }] }));
      else await this.table.documentClient.send(new PutCommand(put));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException" || errorName(error) === "TransactionCanceledException") return false;
      throw error;
    }
  }
  async create(change: PresetChange): Promise<boolean> {
    try {
      await this.table.documentClient.send(new PutCommand({ TableName: this.table.tableName, Item: { ...presetChangeKey(change.scope, change.id), entityType: "LESSON_PRESET_CHANGE", ...structuredClone(change) }, ConditionExpression: "attribute_not_exists(pk)" }));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
  private parse(item: Item | undefined): PresetChange | undefined {
    if (item?.entityType !== "LESSON_PRESET_CHANGE" || typeof item.id !== "string" || !isPreset(item.from) || !isPreset(item.to)) return undefined;
    if (item.state !== "pending" && item.state !== "applied" && item.state !== "cancelled") return undefined;
    if (typeof item.proposedBy !== "string" || typeof item.at !== "number" || typeof item.expiresAt !== "number") return undefined;
    return { id: item.id, scope: item.scope as PresetScope, from: item.from, to: item.to, proposedBy: item.proposedBy, at: item.at, expiresAt: item.expiresAt, state: item.state, ...(typeof item.soleEligibleAtProposal === "boolean" ? { soleEligibleAtProposal: item.soleEligibleAtProposal } : {}) };
  }
  async get(scope: PresetScope, id: string): Promise<PresetChange | undefined> { return this.parse(await this.item(presetChangeKey(scope, id))); }
  async open(scope: PresetScope, now: number): Promise<PresetChange | undefined> {
    const response = await this.table.documentClient.send(new QueryCommand({
      TableName: this.table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true, ExpressionAttributeValues: { ":pk": pkOf(scope), ":p": PRESET_CHANGE_PREFIX },
    })) as { Items?: Item[] };
    return (response.Items ?? []).map((i) => this.parse(i)).find((c) => c !== undefined && c.state === "pending" && c.expiresAt > now);
  }
  async transition(scope: PresetScope, id: string, from: PresetChange["state"], to: PresetChange["state"]): Promise<boolean> {
    try {
      await this.table.documentClient.send(new UpdateCommand({
        TableName: this.table.tableName, Key: presetChangeKey(scope, id), UpdateExpression: "SET #s = :to", ConditionExpression: "#s = :from",
        ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":to": to, ":from": from },
      }));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
}

/**
 * The company switch for the sole-owner exception on loosening, and its proposals. `read` is ON when never set; a stored value that is not a boolean throws (the caller counts it as OFF).
 * `write` is internal to `setSoleOwnerSwitch` / `approveSoleOwnerSwitch` (sole-owner-switch.ts): routes never call it, so an OFF switch can only come back ON through a second admin.
 */
export class DynamoSoleOwnerSwitch implements SoleOwnerSwitchStore {
  constructor(private readonly table: TeamRecordTable) {}
  private async item(key: { pk: string; sk: string }): Promise<Item | undefined> {
    return (await this.table.documentClient.send(new GetCommand({ TableName: this.table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
  }
  async read(workspaceId: string): Promise<boolean> {
    const item = await this.item({ pk: teamRecordPk(workspaceId, undefined), sk: SOLE_OWNER_SK });
    if (item === undefined) return true;
    if (typeof item.enabled !== "boolean") throw new Error("the stored sole-owner setting is not valid");
    return item.enabled;
  }
  async write(workspaceId: string, enabled: boolean, meta: { by: string; at: number }, from: boolean, fence?: Tier0Fence): Promise<boolean> {
    // The item holds no person (the audit event names who); an absent item is ON.
    const put = {
      TableName: this.table.tableName, Item: { pk: teamRecordPk(workspaceId, undefined), sk: SOLE_OWNER_SK, entityType: "LESSON_SOLE_OWNER_SETTING", enabled, updatedAt: meta.at },
      ConditionExpression: from ? "attribute_not_exists(pk) OR #e = :from" : "#e = :from", ExpressionAttributeNames: { "#e": "enabled" }, ExpressionAttributeValues: { ":from": from },
    };
    try {
      if (fence?.conditions !== undefined && fence.conditions.length > 0) await this.table.documentClient.send(new TransactWriteCommand({ TransactItems: [...(fence.conditions as TransactItem[]), { Put: put }] }));
      else await this.table.documentClient.send(new PutCommand(put));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException" || errorName(error) === "TransactionCanceledException") return false;
      throw error;
    }
  }
  async create(change: SoleOwnerSwitchChange): Promise<boolean> {
    try {
      await this.table.documentClient.send(new PutCommand({ TableName: this.table.tableName, Item: { ...soleChangeKey(change.workspaceId, change.id), entityType: "LESSON_SOLE_SWITCH_CHANGE", ...structuredClone(change) }, ConditionExpression: "attribute_not_exists(pk)" }));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
  private parse(item: Item | undefined): SoleOwnerSwitchChange | undefined {
    if (item?.entityType !== "LESSON_SOLE_SWITCH_CHANGE" || typeof item.id !== "string" || typeof item.workspaceId !== "string" || typeof item.from !== "boolean" || typeof item.to !== "boolean") return undefined;
    if (item.state !== "pending" && item.state !== "applied" && item.state !== "cancelled") return undefined;
    if (typeof item.proposedBy !== "string" || typeof item.at !== "number" || typeof item.expiresAt !== "number") return undefined;
    return { id: item.id, workspaceId: item.workspaceId, from: item.from, to: item.to, proposedBy: item.proposedBy, at: item.at, expiresAt: item.expiresAt, state: item.state };
  }
  async get(workspaceId: string, id: string): Promise<SoleOwnerSwitchChange | undefined> { return this.parse(await this.item(soleChangeKey(workspaceId, id))); }
  async open(workspaceId: string, now: number): Promise<SoleOwnerSwitchChange | undefined> {
    const response = await this.table.documentClient.send(new QueryCommand({
      TableName: this.table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": teamRecordPk(workspaceId, undefined), ":p": SOLE_CHANGE_PREFIX },
    })) as { Items?: Item[] };
    return (response.Items ?? []).map((i) => this.parse(i)).find((c) => c !== undefined && c.state === "pending" && c.expiresAt > now);
  }
  async transition(workspaceId: string, id: string, from: SoleOwnerSwitchChange["state"], to: SoleOwnerSwitchChange["state"]): Promise<boolean> {
    try {
      await this.table.documentClient.send(new UpdateCommand({
        TableName: this.table.tableName, Key: soleChangeKey(workspaceId, id), UpdateExpression: "SET #s = :to", ConditionExpression: "#s = :from",
        ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":to": to, ":from": from },
      }));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
}

/**
 * The learning lane's settings reader over the table: the project's mode and the company's lock (the record core's `MODE` and `MODE_LOCK` items), the project's tier-0 setting and the
 * company floor. A mode that is stored but not valid is passed on as it is, so `resolveLearning` turns it into Off; an absent project mode is the record core's default (Suggest).
 * Any read that fails throws, and `resolveLearning` then fails closed.
 */
const LOAD_BUDGET_SK = "LESSONSET#LOADBUDGET";
const loadBudgetKey = (workspaceId: string, project: string) => ({ pk: teamRecordPk(workspaceId, project), sk: LOAD_BUDGET_SK });

/**
 * The project's own load budget (how many lessons and how many bytes a stage may be told), within the caps. Stored under `LESSONSET#`, which the project erase and the workspace erase already wipe; it holds
 * no person. A value outside the caps is refused here and ignored by `resolveLoadBudget` if one is ever found stored. Returns whether the value was stored.
 */
export async function writeLoadBudget(table: TeamRecordTable, scope: { workspaceId: string; project: string }, budget: LoadBudgetSetting, at: number): Promise<boolean> {
  const caps = { lessons: LEARNED_CONTEXT_MAX_LESSONS, bytes: LEARNED_CONTEXT_MAX_BYTES };
  const valid = (value: number | undefined, min: number, max: number): boolean => value === undefined || (Number.isInteger(value) && value >= min && value <= max);
  if (!valid(budget.lessons, LOAD_BUDGET_MIN.lessons, caps.lessons) || !valid(budget.bytes, LOAD_BUDGET_MIN.bytes, caps.bytes)) return false;
  await table.documentClient.send(new PutCommand({
    TableName: table.tableName,
    Item: { ...loadBudgetKey(scope.workspaceId, scope.project), entityType: "LESSON_LOAD_BUDGET", ...(budget.lessons === undefined ? {} : { lessons: budget.lessons }), ...(budget.bytes === undefined ? {} : { bytes: budget.bytes }), updatedAt: at },
  }));
  return true;
}

export function dynamoLearningSettings(table: TeamRecordTable, settings: Tier0SettingsStore): LearningSettingsReader {
  const mode = async (key: { pk: string; sk: string }): Promise<{ present: false } | { present: true; value: Mode }> => {
    const item = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
    if (item === undefined) return { present: false };
    return { present: true, value: (typeof item.mode === "string" ? MODE_NAMES[item.mode] ?? (item.mode as never) : ("invalid" as never)) };
  };
  const presets = new DynamoPresetStore(table);
  // (A stored "auto" is read as "one" while automatic go-live is off: that is `resolveLearning`'s gate, which every consumer goes through.)
  return {
    async read(workspaceId, project) {
      const org = workspaceId;
      const [own, lock, tier0, floor, preset, companyPreset, budget] = await Promise.all([
        mode(learningModeKey(org, project)), mode(learningModeLockKey(org)),
        settings.read({ kind: "project", workspaceId, project }), settings.read({ kind: "company", workspaceId }),
        presets.read({ kind: "project", workspaceId, project }).catch(() => "invalid" as never), presets.read({ kind: "company", workspaceId }).catch(() => "invalid" as never),
        table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: loadBudgetKey(workspaceId, project), ConsistentRead: true })) as Promise<{ Item?: Item }>,
      ]);
      const stored = budget.Item;
      const loadBudget: LoadBudgetSetting | undefined = stored?.entityType !== "LESSON_LOAD_BUDGET" ? undefined : {
        ...(typeof stored.lessons === "number" ? { lessons: stored.lessons } : {}), ...(typeof stored.bytes === "number" ? { bytes: stored.bytes } : {}),
      };
      return {
        mode: own.present ? own.value : MODE_NAMES[LEARNING_MODE_DEFAULT]!,
        ...(lock.present ? { companyLock: lock.value } : {}),
        ...(tier0 === undefined ? {} : { tier0Approval: tier0 }),
        ...(floor === undefined ? {} : { companyApproval: { tier0: floor } }),
        // A preset that is stored but not valid is passed on as it is, so `resolveLearning` turns it into Off.
        ...(preset === undefined ? {} : { preset }), ...(companyPreset === undefined ? {} : { companyPreset }),
        ...(loadBudget === undefined ? {} : { loadBudget }),
      };
    },
  };
}
