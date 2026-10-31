// Learning v2 wiring (LR-W3): where the tier-0 setting and its proposals are stored, on the TeamRecord table, and the settings reader the learning lane reads through.
//   project: pk of the project, sk `LESSONSET#SETTINGS`      (`tier0`: the project's tier0Approval)
//   company: pk of the workspace, sk `LESSONSET#COMPANY`      (`tier0`: the company floor, companyApproval.tier0)
//   proposals: the same pk, sk `LESSONSET#TIER0CHG#<id>`
// Every sort key starts with `LESSONSET`, which the project erase and the workspace erase already wipe.
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LEARNING_MODE_DEFAULT, learningModeKey, learningModeLockKey, teamRecordPk } from "@agentx/contracts";
import { errorName, type Item } from "../agents/table-writes.js";
import type { TeamRecordTable } from "../team-record/types.js";
import { TIER0_APPROVAL_DEFAULT, type LearningSettings, type LearningSettingsReader } from "./policy.js";
import type { Tier0Change, Tier0ChangeStore, Tier0Level, Tier0Scope, Tier0SettingsStore } from "./tier0-setting.js";

const pkOf = (scope: Tier0Scope): string => teamRecordPk(scope.workspaceId, scope.kind === "project" ? scope.project : undefined);
const settingKey = (scope: Tier0Scope) => ({ pk: pkOf(scope), sk: scope.kind === "project" ? "LESSONSET#SETTINGS" : "LESSONSET#COMPANY" });
const changeKey = (scope: Tier0Scope, id: string) => ({ pk: pkOf(scope), sk: `LESSONSET#TIER0CHG#${id.replace(/#/gu, "_")}` });
const isLevel = (value: unknown): value is Tier0Level => value === "auto" || value === "one" || value === "two";
/** The contracts' mode names (lower case) and the policy's (capitalised). */
type Mode = NonNullable<LearningSettings["mode"]>;
const MODE_NAMES: Record<string, Mode> = { off: "Off", collect: "Collect", suggest: "Suggest", on: "On" };

export class DynamoTier0Settings implements Tier0SettingsStore, Tier0ChangeStore {
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

  async write(scope: Tier0Scope, value: Tier0Level, meta: { by: string; at: number }, from: Tier0Level): Promise<boolean> {
    // Conditional on the value the caller read; an absent item is the default, so it matches only when `from` is the default.
    const isDefault = from === (scope.kind === "project" ? TIER0_APPROVAL_DEFAULT : "auto");
    try {
      await this.table.documentClient.send(new PutCommand({
        TableName: this.table.tableName, Item: { ...settingKey(scope), entityType: "LESSON_SETTINGS", tier0: value, updatedBy: meta.by, updatedAt: meta.at },
        ConditionExpression: isDefault ? "attribute_not_exists(pk) OR #t = :from" : "#t = :from", ExpressionAttributeNames: { "#t": "tier0" }, ExpressionAttributeValues: { ":from": from },
      }));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async create(change: Tier0Change): Promise<boolean> {
    try {
      await this.table.documentClient.send(new PutCommand({ TableName: this.table.tableName, Item: { ...changeKey(change.scope, change.id), entityType: "LESSON_TIER0_CHANGE", ...structuredClone(change) }, ConditionExpression: "attribute_not_exists(pk)" }));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  private parse(item: Item | undefined): Tier0Change | undefined {
    if (item?.entityType !== "LESSON_TIER0_CHANGE" || typeof item.id !== "string" || !isLevel(item.from) || !isLevel(item.to)) return undefined;
    if (item.state !== "pending" && item.state !== "applied" && item.state !== "cancelled") return undefined;
    if (typeof item.proposedBy !== "string" || typeof item.at !== "number" || typeof item.expiresAt !== "number") return undefined;
    return { id: item.id, scope: item.scope as Tier0Scope, from: item.from, to: item.to, proposedBy: item.proposedBy, at: item.at, expiresAt: item.expiresAt, state: item.state };
  }

  async get(scope: Tier0Scope, id: string): Promise<Tier0Change | undefined> { return this.parse(await this.item(changeKey(scope, id))); }
  async open(scope: Tier0Scope, now: number): Promise<Tier0Change | undefined> {
    const response = await this.table.documentClient.send(new QueryCommand({
      TableName: this.table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": pkOf(scope), ":p": "LESSONSET#TIER0CHG#" },
    })) as { Items?: Item[] };
    return (response.Items ?? []).map((i) => this.parse(i)).find((c) => c !== undefined && c.state === "pending" && c.expiresAt > now);
  }

  async transition(scope: Tier0Scope, id: string, from: Tier0Change["state"], to: Tier0Change["state"]): Promise<boolean> {
    try {
      await this.table.documentClient.send(new UpdateCommand({
        TableName: this.table.tableName, Key: changeKey(scope, id), UpdateExpression: "SET #s = :to", ConditionExpression: "#s = :from",
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
export function dynamoLearningSettings(table: TeamRecordTable, settings: Tier0SettingsStore): LearningSettingsReader {
  const mode = async (key: { pk: string; sk: string }): Promise<{ present: false } | { present: true; value: Mode }> => {
    const item = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
    if (item === undefined) return { present: false };
    return { present: true, value: (typeof item.mode === "string" ? MODE_NAMES[item.mode] ?? (item.mode as never) : ("invalid" as never)) };
  };
  // (A stored "auto" is read as "one" while automatic go-live is off: that is `resolveLearning`'s gate, which every consumer goes through.)
  return {
    async read(workspaceId, project) {
      const org = workspaceId;
      const [own, lock, tier0, floor] = await Promise.all([
        mode(learningModeKey(org, project)), mode(learningModeLockKey(org)),
        settings.read({ kind: "project", workspaceId, project }), settings.read({ kind: "company", workspaceId }),
      ]);
      return {
        mode: own.present ? own.value : MODE_NAMES[LEARNING_MODE_DEFAULT]!,
        ...(lock.present ? { companyLock: lock.value } : {}),
        ...(tier0 === undefined ? {} : { tier0Approval: tier0 }),
        ...(floor === undefined ? {} : { companyApproval: { tier0: floor } }),
      };
    },
  };
}
