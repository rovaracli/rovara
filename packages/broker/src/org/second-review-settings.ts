// Second review (SR-1, switch `cr`): what the company and its projects set about it, kept in the State table beside the company's other settings. Nothing new in the broker's environment: this is stored data.
//   SECONDREVIEW#SETTINGS            the company's `default` mode and `lock` (a floor), and its CHOICE of reviewer: a primary model and an optional backup (`models`, at most 2).
//   SECONDREVIEW#PROJECT#<project>   the project's mode and its narrowing of the company's choice (a subset, never wider).
//   SECONDREVIEW#VERDICT#<key>       the evidence that lets a model run in `on` (written by Rovara staff / the install, never by a route here) and SECONDREVIEW#REPLAY#<runId> the replay run it names.
// Every read fails closed: a stored value that cannot be read never turns into a looser setting. An unreadable mode is `off`, an unreadable choice is a choice that holds nothing (nothing runs, and it is flagged;
// it never falls back to the default), an unreadable verdict or replay run is absent (so `on` is never reached on bad evidence).
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { orgMetaKey, SecondReviewModeSchema, SecondReviewModelListSchema, SecondReviewReplayRunSchema, SecondReviewVerdictSchema, type SecondReviewMode, type SecondReviewModelRef, type SecondReviewReplayRun, type SecondReviewVerdict } from "@agentx/contracts";

export interface SettingsTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }
type Item = Record<string, unknown>;

export const SECOND_REVIEW_SETTINGS_SK = "SECONDREVIEW#SETTINGS";
const PROJECT_PREFIX = "SECONDREVIEW#PROJECT#";
const VERDICT_PREFIX = "SECONDREVIEW#VERDICT#";
const REPLAY_PREFIX = "SECONDREVIEW#REPLAY#";
const orgPk = (orgId: string): string => orgMetaKey(orgId as never).pk;
export const secondReviewProjectKey = (orgId: string, project: string) => ({ pk: orgPk(orgId), sk: `${PROJECT_PREFIX}${project.replace(/#/gu, "_")}` });

export interface SecondReviewSettings {
  companyDefault?: SecondReviewMode | undefined;
  companyLock?: SecondReviewMode | undefined;
  projectMode?: SecondReviewMode | undefined;
  /** The company's choice (primary, then backup). Undefined: nobody chose. An empty list: a choice that could not be read. */
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

/** Reads everything the plan needs. A read that fails is the caller's to handle (the start treats it as "no second review", never as a looser setting). */
export async function readSecondReviewSettings(table: SettingsTable, orgId: string, project: string): Promise<SecondReviewSettings> {
  const [company, projectItem, verdictRows, replayRows] = await Promise.all([
    get(table, { pk: orgPk(orgId), sk: SECOND_REVIEW_SETTINGS_SK }),
    get(table, secondReviewProjectKey(orgId, project)),
    table.documentClient.send(new QueryCommand({ TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true, Limit: 50, ExpressionAttributeValues: { ":pk": orgPk(orgId), ":p": VERDICT_PREFIX } })) as Promise<{ Items?: Item[] }>,
    table.documentClient.send(new QueryCommand({ TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true, Limit: 50, ExpressionAttributeValues: { ":pk": orgPk(orgId), ":p": REPLAY_PREFIX } })) as Promise<{ Items?: Item[] }>,
  ]);
  const verdicts: SecondReviewVerdict[] = [];
  for (const row of verdictRows.Items ?? []) { const parsed = SecondReviewVerdictSchema.safeParse(row.verdict); if (parsed.success) verdicts.push(parsed.data); }
  const replayRuns: SecondReviewReplayRun[] = [];
  for (const row of replayRows.Items ?? []) { const parsed = SecondReviewReplayRunSchema.safeParse(row.run); if (parsed.success) replayRuns.push(parsed.data); }
  return {
    companyDefault: modeOf(company?.default), companyLock: modeOf(company?.lock), projectMode: modeOf(projectItem?.mode),
    companyModels: modelsOf(company), projectModels: modelsOf(projectItem), verdicts, replayRuns,
  };
}

export interface ChoiceChange { orgId: string; models: SecondReviewModelRef[] | undefined; by: string; at: number }

/** Sets the company's choice (primary, optional backup), or clears it (`models` undefined: nobody has chosen, the default stands). Keeps the company's modes as they are. */
export async function writeCompanyChoice(table: SettingsTable, change: ChoiceChange): Promise<void> {
  const current = await get(table, { pk: orgPk(change.orgId), sk: SECOND_REVIEW_SETTINGS_SK });
  const { models: _old, ...rest } = current ?? {};
  void _old;
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: {
    ...rest, pk: orgPk(change.orgId), sk: SECOND_REVIEW_SETTINGS_SK, entityType: "SECOND_REVIEW_SETTINGS",
    ...(change.models === undefined ? {} : { models: change.models }), updatedAt: change.at, updatedBy: change.by,
  } }));
}

/** Sets a project's narrowing of the company's choice, or clears it. Keeps the project's mode as it is. */
export async function writeProjectNarrowing(table: SettingsTable, change: { orgId: string; project: string; models: SecondReviewModelRef[] | undefined; by: string; at: number }): Promise<void> {
  const key = secondReviewProjectKey(change.orgId, change.project);
  const current = await get(table, key);
  const { models: _old, ...rest } = current ?? {};
  void _old;
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: {
    ...rest, ...key, entityType: "SECOND_REVIEW_PROJECT", ...(change.models === undefined ? {} : { models: change.models }), updatedAt: change.at, updatedBy: change.by,
  } }));
}
