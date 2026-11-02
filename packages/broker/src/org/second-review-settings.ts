// Second review (SR-1, switch `cr`): what the company and its projects set about it, kept in the State table beside the company's other settings. Nothing new in the broker's environment: this is stored data.
//   SECONDREVIEW#SETTINGS            the company's `default` mode and `lock` (a floor), and its CHOICE of reviewer: a primary model and an optional backup (`models`, at most 2).
//   SECONDREVIEW#PROJECT#<project>   the project's mode and its narrowing of the company's choice (a subset, never wider).
//   SECONDREVIEW#VERDICT#<key>       the evidence that lets a model run in `on` (written by Rovara staff / the install, never by a route here) and SECONDREVIEW#REPLAY#<runId> the replay run it names.
// Every read fails closed: a stored value that cannot be read never turns into a looser setting. An unreadable mode is `off`, an unreadable choice is a choice that holds nothing (nothing runs, and it is flagged;
// it never falls back to the default), an unreadable verdict or replay run is absent (so `on` is never reached on bad evidence).
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { orgMetaKey, SecondReviewContextSchema, SecondReviewModeSchema, SecondReviewModelListSchema, SecondReviewReplayRunSchema, SecondReviewVerdictSchema, type SecondReviewContext, type SecondReviewMode, type SecondReviewModelRef, type SecondReviewReplayRun, type SecondReviewVerdict } from "@agentx/contracts";

export interface SettingsTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }
type Item = Record<string, unknown>;

export const SECOND_REVIEW_SETTINGS_SK = "SECONDREVIEW#SETTINGS";
const PROJECT_PREFIX = "SECONDREVIEW#PROJECT#";
const VERDICT_PREFIX = "SECONDREVIEW#VERDICT#";
const REPLAY_PREFIX = "SECONDREVIEW#REPLAY#";
const orgPk = (orgId: string): string => orgMetaKey(orgId).pk;
export const secondReviewVerdictKey = (orgId: string, modelKey: string) => ({ pk: orgPk(orgId), sk: `${VERDICT_PREFIX}${modelKey.replace(/#/gu, "_")}` });
export const secondReviewReplayKey = (orgId: string, runId: string) => ({ pk: orgPk(orgId), sk: `${REPLAY_PREFIX}${runId.replace(/#/gu, "_")}` });
export const secondReviewProjectKey = (orgId: string, project: string) => {
  // A project name never holds the separator (project names are validated names); two names must never share a key.
  if (project.includes("#")) throw new Error("a project name cannot hold #");
  return { pk: orgPk(orgId), sk: `${PROJECT_PREFIX}${project}` };
};

export interface SecondReviewSettings {
  companyDefault?: SecondReviewMode | undefined;
  companyLock?: SecondReviewMode | undefined;
  /** The project's mode as it counts NOW. A project pinned `on` stops counting once the company has been LOWERED since the pin was written (the lowering reaches the project too); it counts again only when an admin pins it afresh. */
  projectMode?: SecondReviewMode | undefined;
  /** When the company was last LOWERED (ms), as read. A pin written against it is conditional on it, so a pin racing a lowering fails. */
  companyLoweredAt?: number | undefined;
  /** The project's stored mode, whether or not it still counts. The writer guards its transaction with this one. */
  projectModeStored?: SecondReviewMode | undefined;
  /** The company's choice (primary, then backup). Undefined: nobody chose. An empty list: a choice that could not be read. */
  /** What the second reviewer sees besides the change. Anything unreadable is `change_only`, the narrower. */
  context: SecondReviewContext;
  companyModels?: SecondReviewModelRef[] | undefined;
  /** The project's narrowing. Same meaning as above. */
  projectModels?: SecondReviewModelRef[] | undefined;
  verdicts: SecondReviewVerdict[];
  replayRuns: SecondReviewReplayRun[];
}

const modeOf = (value: unknown): SecondReviewMode | undefined => { const parsed = SecondReviewModeSchema.safeParse(value); return parsed.success ? parsed.data : undefined; };
/** A stored model list: undefined when never set, [] when set but unreadable. */
function modelsOf(item: Item | undefined): SecondReviewModelRef[] | undefined {
  if (item === undefined || item.models === undefined) return undefined;
  const parsed = SecondReviewModelListSchema.safeParse(item.models);
  return parsed.success ? parsed.data : [];
}

async function get(table: SettingsTable, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
}

/** Every verdict row of the company, paged through to the end (a company may hold more than one page of models). */
async function allVerdictRows(table: SettingsTable, orgId: string): Promise<Item[]> {
  const rows: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true, Limit: 50, ExpressionAttributeValues: { ":pk": orgPk(orgId), ":p": VERDICT_PREFIX },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    rows.push(...(response.Items ?? []));
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return rows;
}

/** Reads everything the plan needs. A read that fails is the caller's to handle (the start treats it as "no second review", never as a looser setting). */
export async function readSecondReviewSettings(table: SettingsTable, orgId: string, project: string): Promise<SecondReviewSettings> {
  const [company, projectItem, verdictRows] = await Promise.all([
    get(table, { pk: orgPk(orgId), sk: SECOND_REVIEW_SETTINGS_SK }),
    get(table, secondReviewProjectKey(orgId, project)),
    allVerdictRows(table, orgId),
  ]);
  const verdicts: SecondReviewVerdict[] = [];
  for (const row of verdictRows) { const parsed = SecondReviewVerdictSchema.safeParse(row.verdict); if (parsed.success) verdicts.push(parsed.data); }
  // The replay runs a verdict names, read by their key (a company may hold more runs than a page): a run that is missing or unreadable is absent, so the verdict does not hold.
  const replayRuns: SecondReviewReplayRun[] = [];
  for (const runId of new Set(verdicts.map((verdict) => verdict.replayRunId))) {
    const parsed = SecondReviewReplayRunSchema.safeParse((await get(table, secondReviewReplayKey(orgId, runId)))?.run);
    if (parsed.success) replayRuns.push(parsed.data);
  }
  const stored = modeOf(projectItem?.mode);
  const loweredAt = typeof company?.loweredAt === "number" ? company.loweredAt : undefined;
  const pinnedAt = typeof projectItem?.modeAt === "number" ? projectItem.modeAt : 0;
  const lapsed = stored === "on" && loweredAt !== undefined && pinnedAt <= loweredAt;
  return {
    companyDefault: modeOf(company?.default), companyLock: modeOf(company?.lock), projectMode: lapsed ? undefined : stored, projectModeStored: stored, companyLoweredAt: loweredAt,
    context: SecondReviewContextSchema.safeParse(company?.context).data ?? "change_only", companyModels: modelsOf(company), projectModels: modelsOf(projectItem), verdicts, replayRuns,
  };
}

/** One write for a transaction: it changes ONLY the fields it names (never a read-modify-write of the whole item), so two admins changing different settings cannot undo each other. */
export type SettingsUpdate = { Update: { TableName: string; Key: { pk: string; sk: string }; UpdateExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> } };

function update(table: SettingsTable, key: { pk: string; sk: string }, entityType: string, field: "models" | "context", value: unknown, by: string, at: number): SettingsUpdate {
  const names = { "#f": field, "#t": "updatedAt", "#b": "updatedBy", "#e": "entityType" };
  const values = { ":t": at, ":b": by, ":e": entityType };
  return { Update: {
    TableName: table.tableName, Key: key, ExpressionAttributeNames: names,
    ...(value === undefined
      ? { UpdateExpression: "SET #t = :t, #b = :b, #e = :e REMOVE #f", ExpressionAttributeValues: values }
      : { UpdateExpression: "SET #f = :v, #t = :t, #b = :b, #e = :e", ExpressionAttributeValues: { ...values, ":v": value } }),
  } };
}

/** Sets the company's choice (primary, optional backup), or clears it (`models` undefined: nobody has chosen, the default stands). Touches only `models`. */
export const companyChoiceUpdate = (table: SettingsTable, change: { orgId: string; models: SecondReviewModelRef[] | undefined; by: string; at: number }): SettingsUpdate =>
  update(table, { pk: orgPk(change.orgId), sk: SECOND_REVIEW_SETTINGS_SK }, "SECOND_REVIEW_SETTINGS", "models", change.models, change.by, change.at);

/** Sets what the second reviewer sees besides the change (`change_only` or `same_as_first`). Touches only `context`. */
export const companyContextUpdate = (table: SettingsTable, change: { orgId: string; context: SecondReviewContext; by: string; at: number }): SettingsUpdate =>
  update(table, { pk: orgPk(change.orgId), sk: SECOND_REVIEW_SETTINGS_SK }, "SECOND_REVIEW_SETTINGS", "context", change.context, change.by, change.at);

/** Sets a project's narrowing of the company's choice, or clears it. Touches only `models`. The project name is one the company has (the caller checked it exists) and cannot hold the key separator. */
export const projectNarrowingUpdate = (table: SettingsTable, change: { orgId: string; project: string; models: SecondReviewModelRef[] | undefined; by: string; at: number }): SettingsUpdate =>
  update(table, secondReviewProjectKey(change.orgId, change.project), "SECOND_REVIEW_PROJECT", "models", change.models, change.by, change.at);
