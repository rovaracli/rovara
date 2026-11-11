// Plan 4 Task 16: the AWS CloudWatch connector's tools and the way it gets its credentials. Unlike the other native connectors it holds no key: Rovara assumes
// the role a customer made in their own AWS account, for 15 minutes at a time, and reads alarms, metrics and Logs Insights with that session.
//
// Two rules hold it safe.
//   1. The external id is `cloudwatchExternalId(callerOrg)`, built from the org the request is for, and sent on every AssumeRole. The connection record's own
//      `externalId` is never read (a record cannot be trusted to name the org it belongs to), so a customer's role that requires another org's id is never opened.
//   2. The session carries a policy of its own (`CLOUDWATCH_SESSION_ACTIONS`): nine read actions, so the session can read nothing more whatever the customer's role allows.
//
// A scope is one region, optionally held to log groups and alarms by name prefix. A tool refuses anything outside them before it calls AWS, and checks again
// on what AWS answered. Calls are made with the AWS SDK's own commands through `AwsSender`s the deployment supplies (a test supplies fakes); nothing here uses `fetch`.
//
// AWS documentation confirmed on 2026-10-22: AssumeRole's ExternalId, Policy (session policy, packed size under 2,048 characters) and DurationSeconds (docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html);
// DescribeAlarms (AlarmNamePrefix, AlarmTypes, StateValue, MaxRecords), DescribeAlarmHistory, GetMetricData (CloudWatch API reference); DescribeLogGroups
// (logGroupNamePrefix), StartQuery (logGroupNames up to 50, queryString up to 10,000), GetQueryResults and StopQuery (CloudWatch Logs API reference).
import { randomInt } from "node:crypto";
import { DescribeAlarmHistoryCommand, DescribeAlarmsCommand, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeLogGroupsCommand, GetQueryResultsCommand, StartQueryCommand, StopQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { GetCallerIdentityCommand, type AssumeRoleCommandInput } from "@aws-sdk/client-sts";
import { AWS_REGIONS, agentXError, cloudwatchExternalId, cloudwatchRoleAccount, type OrgConnection, type OrgId } from "@rovara-code/contracts";
import type { CheckResult } from "../../connections/store.js";
import { NativeToolRefusal, type NativeRouting, type NativeTool } from "./runtime.js";

type CloudWatchConnection = Extract<OrgConnection, { type: "cloudwatch" }>;

// ---- the AWS port

/** One AWS client, as the connector uses it: it sends an SDK command and answers its output. */
export interface AwsSender { send(command: unknown): Promise<unknown> }

export interface AssumedAwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }

/**
 * What the CloudWatch connector needs of AWS, supplied by the deployment (`awsCloudWatchAccess`) or a test. Nothing in the connector reads the environment or
 * builds a client of its own.
 */
export interface CloudWatchAws {
  /** The AWS account the deployment runs in; a role in it is refused. Undefined where it is not known. */
  ownAccountId: string | undefined;
  /** STS AssumeRole with the broker's own identity. The connector sets every field (the external id above all). */
  assumeRole(input: AssumeRoleCommandInput): Promise<AssumedAwsCredentials>;
  /** Clients that sign with the assumed session, for one region. */
  clientsFor(credentials: AssumedAwsCredentials, region: string): { sts: AwsSender; monitoring: AwsSender; logs: AwsSender };
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Random lower-case letters and digits for the check's wrong external id; a test supplies its own. */
  random?(): string;
}

// ---- the session

/** The only actions a session may use: reads. Passed as the session policy, so the connector is read-only whatever the customer's role allows. */
export const CLOUDWATCH_SESSION_ACTIONS = [
  "cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory", "cloudwatch:GetMetricData", "cloudwatch:ListMetrics",
  "logs:DescribeLogGroups", "logs:FilterLogEvents", "logs:StartQuery", "logs:GetQueryResults", "logs:StopQuery",
] as const;

export const cloudwatchSessionPolicy = (): string => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: [...CLOUDWATCH_SESSION_ACTIONS], Resource: "*" }] });

export const ROLE_REFUSED = "AWS refused to let Rovara assume the role; check the role's ARN, its trust policy and its external id";
export const ROLE_UNREACHABLE = "AWS could not be reached to assume the role; try again";
export const OWN_ACCOUNT_ROLE = "the role must be in your own AWS account, not Rovara's";
const NO_ALARM_READ = "Rovara assumed the role but it cannot read CloudWatch alarms; give it cloudwatch:DescribeAlarms (for example the CloudWatchReadOnlyAccess policy)";

/** Assuming the role failed in a way a person can act on (`retryable` false) or not (true: AWS could not be reached). `message` is fixed words. */
export class CloudWatchAccessError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = "CloudWatchAccessError"; }
}

const randomBase36 = (): string => Array.from({ length: 20 }, () => randomInt(36).toString(36)).join("");
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "");
const DENIED = new Set(["AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "UnauthorizedException"]);
const THROTTLED = new Set(["Throttling", "ThrottlingException", "TooManyRequestsException", "RequestLimitExceeded", "LimitExceededException"]);
const NOT_FOUND = new Set(["ResourceNotFoundException", "ResourceNotFound"]);

/**
 * Assumes the customer's role for this org. The external id is built from `orgId`, the org the request is for, and never from the record; every call sends it.
 * A role in the deployment's own account is refused before AWS is asked.
 */
export async function assumeCustomerRole(aws: CloudWatchAws, input: { orgId: OrgId; connection: CloudWatchConnection }): Promise<AssumedAwsCredentials> {
  return assumeWith(aws, input.connection, cloudwatchExternalId(input.orgId));
}

/** One AssumeRole for the connection's role with the given external id: the caller org's own, or the check's wrong one. */
async function assumeWith(aws: CloudWatchAws, connection: CloudWatchConnection, externalId: string): Promise<AssumedAwsCredentials> {
  if (aws.ownAccountId !== undefined && cloudwatchRoleAccount(connection.roleArn) === aws.ownAccountId) throw new CloudWatchAccessError(OWN_ACCOUNT_ROLE, false);
  try {
    return await aws.assumeRole({
      RoleArn: connection.roleArn,
      RoleSessionName: `rovara-${connection.connectionId}`,
      ExternalId: externalId,
      DurationSeconds: 900,
      Policy: cloudwatchSessionPolicy(),
    });
  } catch (error) {
    // What AWS said can quote the role, the account or the request: only its class decides the words.
    throw new CloudWatchAccessError(DENIED.has(errorName(error)) ? ROLE_REFUSED : ROLE_UNREACHABLE, !DENIED.has(errorName(error)));
  }
}

/** The credentials as the one string the engine passes around as a token. It is never shown: everything a tool answers is scrubbed of its parts. */
export const packCredentials = (credentials: AssumedAwsCredentials): string => JSON.stringify({ a: credentials.accessKeyId, s: credentials.secretAccessKey, t: credentials.sessionToken, e: credentials.expiration.toISOString() });

export function unpackCredentials(token: string): AssumedAwsCredentials | undefined {
  try {
    const value = JSON.parse(token) as Record<string, unknown>;
    if (typeof value["a"] !== "string" || typeof value["s"] !== "string" || typeof value["t"] !== "string" || typeof value["e"] !== "string") return undefined;
    return { accessKeyId: value["a"], secretAccessKey: value["s"], sessionToken: value["t"], expiration: new Date(value["e"]) };
  } catch {
    return undefined;
  }
}

/** The trust policy a customer pastes into the role Rovara assumes: the broker's role as principal, and the caller org's external id required. */
export function cloudwatchTrustPolicy(input: { brokerRoleArn: string; externalId: string }) {
  return {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { AWS: input.brokerRoleArn }, Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": input.externalId } } }],
  } as const;
}

// ---- the check

/**
 * The connection check: assume the role, ask who the session is (`GetCallerIdentity`, which needs no permission), then read one alarm. A refusal a person can act
 * on is a failed check in fixed words; AWS being unreachable is a retryable `RUNTIME_UNAVAILABLE`, recorded as nothing.
 */
export async function checkCloudWatch(aws: CloudWatchAws, input: { orgId: OrgId; connection: CloudWatchConnection }): Promise<CheckResult> {
  const unreachable = () => agentXError("RUNTIME_UNAVAILABLE", "could not reach AWS to check the connection");
  let credentials: AssumedAwsCredentials;
  try {
    credentials = await assumeCustomerRole(aws, input);
  } catch (error) {
    if (error instanceof CloudWatchAccessError && !error.retryable) return { ok: false, message: error.message };
    throw unreachable();
  }
  // The role must refuse any other external id. A trust policy with no external id condition, or one that matches by prefix, would let another org that learns
  // the role's ARN read this account through Rovara (the Bedrock probe does the same, `model-proxy/client.ts`). The second session is never used.
  const expected = cloudwatchExternalId(input.orgId);
  let accepted: boolean;
  try {
    await assumeWith(aws, input.connection, `rovara-org_${(aws.random ?? randomBase36)()}`);
    accepted = true;
  } catch (error) {
    if (!(error instanceof CloudWatchAccessError) || error.retryable) throw unreachable();
    accepted = false;
  }
  if (accepted) return { ok: false, message: `this role's trust policy must require the external id ${expected}` };
  const clients = aws.clientsFor(credentials, input.connection.regions[0]!);
  try {
    await clients.sts.send(new GetCallerIdentityCommand({}));
  } catch {
    throw unreachable();
  }
  try {
    await clients.monitoring.send(new DescribeAlarmsCommand({ MaxRecords: 1 }));
  } catch (error) {
    if (DENIED.has(errorName(error))) return { ok: false, message: NO_ALARM_READ };
    throw unreachable();
  }
  return { ok: true };
}

// ---- the scope

export interface CloudWatchEngineScope { alias: string; region: string; logGroupPrefixes?: string[] | undefined; alarmNamePrefix?: string | undefined }

/** What a tool runs with: the scope, and the session's clients for the scope's region. */
export interface CloudWatchRunScope {
  alias: string;
  region: string;
  logGroupPrefixes: string[];
  /** Empty: every alarm of the region. */
  alarmNamePrefix: string;
  aws: { monitoring: AwsSender; logs: AwsSender; now(): number; sleep(ms: number): Promise<void> };
}

const LOG_GROUP_PREFIX = "[A-Za-z0-9_/.#-]{1,512}";
const ALARM_CHARS = "[A-Za-z0-9_.:/#@=+ -]";

/** The values the server binds on every call. The log group prefixes are one comma-joined string (a prefix holds no comma). */
export const CLOUDWATCH_ROUTING_PROPERTIES: NativeRouting<unknown>["properties"] = {
  scopeAlias: { type: "string", minLength: 1, maxLength: 63 },
  region: { type: "string", enum: [...AWS_REGIONS] },
  logGroupPrefixes: { type: "string", pattern: `^(${LOG_GROUP_PREFIX}(,${LOG_GROUP_PREFIX}){0,4})?$` },
  alarmNamePrefix: { type: "string", pattern: `^${ALARM_CHARS}{0,255}$` },
};

export const cloudwatchRoutingValues = (scope: CloudWatchEngineScope): Record<string, string> => ({
  scopeAlias: scope.alias, region: scope.region, logGroupPrefixes: (scope.logGroupPrefixes ?? []).join(","), alarmNamePrefix: scope.alarmNamePrefix ?? "",
});

/** The tools a scope cannot use, with the reason shown to the administrator: a scope with no log group prefix has no log search. */
export const cloudwatchUnavailableTools = (scope: CloudWatchEngineScope): ReadonlyArray<{ tool: string; reason: string }> =>
  (scope.logGroupPrefixes ?? []).length === 0 ? [{ tool: "query_logs", reason: "this scope names no log group prefixes, so it has no log search" }] : [];

// ---- helpers

const CLIP = 300;
const clip = (value: unknown, max = CLIP): string => {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const when = (value: unknown): string => (value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : "");

/** Sends one command and answers its output; an AWS failure becomes a refusal in fixed words by its class, never its message. */
async function send(sender: AwsSender, command: unknown): Promise<Record<string, unknown>> {
  try {
    return recordOf(await sender.send(command));
  } catch (error) {
    throw awsRefusal(error);
  }
}

function awsRefusal(error: unknown): Error {
  if (error instanceof NativeToolRefusal) return error;
  const name = errorName(error);
  if (DENIED.has(name)) return new NativeToolRefusal("AWS refused the request; check that the role allows CloudWatch reads", "vendor_error");
  if (THROTTLED.has(name)) return new NativeToolRefusal("AWS is limiting requests; try again later", "vendor_error");
  if (NOT_FOUND.has(name)) return new NativeToolRefusal("AWS has no such resource in this region", "vendor_error");
  return new NativeToolRefusal("AWS could not answer the request", "vendor_error");
}

// ---- list_alarms

const listAlarms: NativeTool<CloudWatchRunScope> = {
  name: "list_alarms",
  description: "List the CloudWatch alarms of this scope's region (those whose name starts with the scope's prefix), optionally only those in one state.",
  inputSchema: {
    type: "object",
    properties: { state: { type: "string", enum: ["ALARM", "OK", "INSUFFICIENT_DATA"], description: "Only alarms in this state" } },
    required: [],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const prefix = ctx.scope.alarmNamePrefix;
    const output = await send(ctx.scope.aws.monitoring, new DescribeAlarmsCommand({
      AlarmTypes: ["MetricAlarm", "CompositeAlarm"],
      ...(prefix === "" ? {} : { AlarmNamePrefix: prefix }),
      ...(typeof args["state"] === "string" ? { StateValue: args["state"] as "ALARM" | "OK" | "INSUFFICIENT_DATA" } : {}),
      MaxRecords: 50,
    }));
    // The prefix is the server's, but the answer is not trusted to have kept to it.
    const alarms = [...listOf(output["MetricAlarms"]), ...listOf(output["CompositeAlarms"])].filter(isRecord)
      .filter((alarm) => typeof alarm["AlarmName"] === "string" && alarm["AlarmName"].startsWith(prefix))
      .filter((alarm) => typeof args["state"] !== "string" || alarm["StateValue"] === args["state"]).slice(0, 50);
    if (alarms.length === 0) return { text: `No alarms in ${ctx.scope.alias}.` };
    const lines = alarms.map((alarm) => {
      const metric = typeof alarm["MetricName"] === "string" ? ` ${clip(alarm["Namespace"], 80)}/${clip(alarm["MetricName"], 80)}` : "";
      return `${clip(alarm["AlarmName"], 255)} [${clip(alarm["StateValue"], 20)}]${metric} since ${when(alarm["StateUpdatedTimestamp"])}: ${clip(alarm["StateReason"], 200)}`;
    });
    return { text: `${String(alarms.length)} alarm${alarms.length === 1 ? "" : "s"} in ${ctx.scope.alias}:\n${lines.join("\n")}` };
  },
};

// ---- get_alarm_history

const getAlarmHistory: NativeTool<CloudWatchRunScope> = {
  name: "get_alarm_history",
  description: "Read the history of one alarm of this scope (state changes and configuration changes), newest first, over the last 1 to 72 hours (default 24).",
  inputSchema: {
    type: "object",
    properties: {
      alarmName: { type: "string", pattern: `^${ALARM_CHARS}{1,255}$`, description: "The alarm's name" },
      hoursAgo: { type: "integer", minimum: 1, maximum: 72, description: "How far back to look, in hours (default 24)" },
    },
    required: ["alarmName"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const name = String(args["alarmName"]);
    // The alarm must be one of the scope's, before AWS is asked.
    if (!name.startsWith(ctx.scope.alarmNamePrefix)) throw new NativeToolRefusal(`that alarm is not in ${ctx.scope.alias}`);
    const hours = typeof args["hoursAgo"] === "number" ? args["hoursAgo"] : 24;
    const end = ctx.scope.aws.now();
    const output = await send(ctx.scope.aws.monitoring, new DescribeAlarmHistoryCommand({
      AlarmName: name, AlarmTypes: ["MetricAlarm", "CompositeAlarm"], StartDate: new Date(end - hours * 3_600_000), EndDate: new Date(end), ScanBy: "TimestampDescending", MaxRecords: 50,
    }));
    const items = listOf(output["AlarmHistoryItems"]).filter(isRecord).filter((item) => item["AlarmName"] === name).slice(0, 50);
    if (items.length === 0) return { text: `No history for ${name} in the last ${String(hours)} hour${hours === 1 ? "" : "s"}.` };
    return { text: `${String(items.length)} history item${items.length === 1 ? "" : "s"} for ${name}:\n${items.map((item) => `${when(item["Timestamp"])} ${clip(item["HistoryItemType"], 40)}: ${clip(item["HistorySummary"], 250)}`).join("\n")}` };
  },
};

// ---- get_metric_data

const METRIC_NAME = "^[A-Za-z0-9_.:/#-]{1,255}$";
const MAX_DIMENSIONS = 10;
const DIMENSION_NAME = /^[A-Za-z0-9_.:/@#=+-]{1,255}$/u;

const getMetricData: NativeTool<CloudWatchRunScope> = {
  name: "get_metric_data",
  description: "Read one to five CloudWatch metrics of this scope's region over a recent window, at a period of 60 to 3,600 seconds (a multiple of 60).",
  inputSchema: {
    type: "object",
    properties: {
      queries: {
        type: "array", minItems: 1, maxItems: 5,
        items: {
          type: "object",
          properties: {
            namespace: { type: "string", pattern: METRIC_NAME, description: "The metric's namespace, for example AWS/Lambda" },
            metricName: { type: "string", pattern: METRIC_NAME, description: "The metric's name, for example Errors" },
            dimensions: { type: "object", additionalProperties: { type: "string", minLength: 1, maxLength: 1024 }, description: "Dimension name to value (at most 10)" },
            stat: { type: "string", enum: ["Average", "Sum", "Maximum", "Minimum", "p90", "p99"], description: "The statistic" },
          },
          required: ["namespace", "metricName", "stat"],
          additionalProperties: false,
        },
      },
      fromMinutesAgo: { type: "integer", minimum: 5, maximum: 1440, description: "How far back the window starts, in minutes" },
      periodSeconds: { type: "integer", minimum: 60, maximum: 3600, description: "The period of each datapoint, in seconds (a multiple of 60)" },
    },
    required: ["queries", "fromMinutesAgo", "periodSeconds"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const period = Number(args["periodSeconds"]);
    if (period % 60 !== 0) throw new NativeToolRefusal("periodSeconds must be a multiple of 60");
    const queries = listOf(args["queries"]).filter(isRecord).map((query, index) => {
      const dimensions = Object.entries(recordOf(query["dimensions"]));
      if (dimensions.length > MAX_DIMENSIONS) throw new NativeToolRefusal(`a query may name at most ${String(MAX_DIMENSIONS)} dimensions`);
      for (const [name] of dimensions) if (!DIMENSION_NAME.test(name)) throw new NativeToolRefusal("a dimension name may hold only letters, digits and _ . : / @ # = + -");
      return {
        Id: `q${String(index)}`,
        ReturnData: true,
        MetricStat: {
          Period: period,
          Stat: String(query["stat"]),
          Metric: { Namespace: String(query["namespace"]), MetricName: String(query["metricName"]), Dimensions: dimensions.map(([Name, Value]) => ({ Name, Value: String(Value) })) },
        },
      };
    });
    const end = ctx.scope.aws.now();
    const output = await send(ctx.scope.aws.monitoring, new GetMetricDataCommand({
      MetricDataQueries: queries, StartTime: new Date(end - Number(args["fromMinutesAgo"]) * 60_000), EndTime: new Date(end), ScanBy: "TimestampAscending",
    }));
    const results = listOf(output["MetricDataResults"]).filter(isRecord);
    if (results.length === 0) return { text: "No metric data." };
    const blocks = results.map((result) => {
      const values = listOf(result["Values"]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const stamps = listOf(result["Timestamps"]);
      const label = `${clip(result["Label"], 120)} (${clip(result["StatusCode"], 30)})`;
      if (values.length === 0) return `${label}: no datapoints`;
      const sum = values.reduce((total, value) => total + value, 0);
      const points = values.slice(-48).map((value, offset) => `${when(stamps[values.length - Math.min(48, values.length) + offset])} ${String(Math.round(value * 1000) / 1000)}`);
      return `${label}: ${String(values.length)} datapoints, min ${String(Math.min(...values))}, max ${String(Math.max(...values))}, average ${String(Math.round((sum / values.length) * 1000) / 1000)}\n${points.join("\n")}`;
    });
    return { text: blocks.join("\n\n") };
  },
};

// ---- query_logs

const MAX_LOG_GROUPS = 50;
const QUERY_WAIT_MS = 20_000;
const QUERY_POLL_MS = 1_000;
const MAX_ROWS = 100;
/** `SOURCE` (as a command, at the start or after a pipe or a new line) names log groups of the query's own: the scope's are the only ones allowed. */
const SOURCE_COMMAND = /(^|[|\n\r\u0085\u2028\u2029])\s*source\b/iu;
/** `SOURCE logGroups(` anywhere in the query, whatever comes before it and whatever separates the two words (review M-1). */
const SOURCE_LOG_GROUPS = /\bsource[\s\p{Cc}\p{Cf}]*loggroups[\s\p{Cc}\p{Cf}]*\(/iu;
const TERMINAL_FAILURES = new Set(["Failed", "Cancelled", "Timeout", "Unknown"]);

const queryLogs: NativeTool<CloudWatchRunScope> = {
  name: "query_logs",
  description: "Run a CloudWatch Logs Insights query over this scope's log groups (those whose name starts with the scope's prefixes), over a window of 5 to 1,440 minutes. Waits up to 20 seconds.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 1000, description: "A Logs Insights query, for example: fields @timestamp, @message | filter @message like /ERROR/ | limit 20" },
      fromMinutesAgo: { type: "integer", minimum: 5, maximum: 1440, description: "How far back the window starts, in minutes" },
    },
    required: ["query", "fromMinutesAgo"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const query = String(args["query"]);
    if (SOURCE_COMMAND.test(query) || SOURCE_LOG_GROUPS.test(query)) throw new NativeToolRefusal("a query may not name its own log groups (SOURCE); the scope's log groups are used");
    const prefixes = ctx.scope.logGroupPrefixes;
    if (prefixes.length === 0) throw new NativeToolRefusal("this scope names no log group prefixes, so it has no log search");
    // The groups are those AWS lists for each prefix, and each is checked against the prefixes again.
    const groups: string[] = [];
    for (const prefix of prefixes) {
      const listed = await send(ctx.scope.aws.logs, new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, limit: MAX_LOG_GROUPS }));
      for (const group of listOf(listed["logGroups"]).filter(isRecord)) {
        const name = group["logGroupName"];
        if (typeof name === "string" && prefixes.some((held) => name.startsWith(held)) && !groups.includes(name)) groups.push(name);
      }
    }
    if (groups.length === 0) throw new NativeToolRefusal("no log group matches this scope's prefixes");
    const end = ctx.scope.aws.now();
    const started = await send(ctx.scope.aws.logs, new StartQueryCommand({
      logGroupNames: groups.slice(0, MAX_LOG_GROUPS), queryString: query,
      startTime: Math.floor((end - Number(args["fromMinutesAgo"]) * 60_000) / 1000), endTime: Math.floor(end / 1000), limit: MAX_ROWS,
    }));
    const queryId = started["queryId"];
    if (typeof queryId !== "string") throw new NativeToolRefusal("AWS could not answer the request", "vendor_error");
    let settled = false;
    try {
      for (;;) {
        const answer = await send(ctx.scope.aws.logs, new GetQueryResultsCommand({ queryId }));
        const status = String(answer["status"]);
        if (status === "Complete") {
          settled = true;
          return { text: rowsText(answer, ctx.scope.alias) };
        }
        if (TERMINAL_FAILURES.has(status)) {
          settled = true;
          throw new NativeToolRefusal(`the log query ended as ${clip(status, 20)}`, "vendor_error");
        }
        if (ctx.scope.aws.now() - end >= QUERY_WAIT_MS) throw new NativeToolRefusal("the log query did not finish in 20 seconds and was stopped; narrow the time range or the query", "vendor_error");
        await ctx.scope.aws.sleep(QUERY_POLL_MS);
      }
    } finally {
      // A query that is still running, or whose results could not be read, is stopped so it does not keep running (and costing) on the customer's account.
      if (!settled) await ctx.scope.aws.logs.send(new StopQueryCommand({ queryId })).catch(() => undefined);
    }
  },
};

function rowsText(answer: Record<string, unknown>, alias: string): string {
  const rows = listOf(answer["results"]).filter(Array.isArray).slice(0, MAX_ROWS);
  if (rows.length === 0) return `The query matched no records in ${alias}'s log groups.`;
  const lines = rows.map((row) => (row as unknown[]).filter(isRecord).filter((cell) => cell["field"] !== "@ptr").map((cell) => `${clip(cell["field"], 60)}=${clip(cell["value"], 300)}`).join(" | "));
  return `${String(rows.length)} record${rows.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

export const CLOUDWATCH_TOOLS: readonly NativeTool<CloudWatchRunScope>[] = [listAlarms, getAlarmHistory, getMetricData, queryLogs];
/** The tools a project may approve on a cloudwatch connector (`PROJECT_CONNECTOR_TOOLS.cloudwatch`). */
export const CLOUDWATCH_TOOL_NAMES: readonly string[] = CLOUDWATCH_TOOLS.map((tool) => tool.name);
