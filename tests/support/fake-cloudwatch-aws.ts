// Plan 4 Task 16: a fake of the AWS side of the CloudWatch connector (`CloudWatchAws`, packages/broker/src/connectors/native/cloudwatch.ts). It stands in for
// STS, CloudWatch and CloudWatch Logs, so no test reaches AWS. STS enforces the customer role's trust policy the way the real one does for the external id:
// a role names the one external id it requires, and an AssumeRole call without it (or with another) is refused. Every call is recorded with the region
// it was made in and the credentials that signed it, so a test can say what was asked, where, and as whom. The clients take the SDK's own command objects
// and answer by the command's class name.
import type { AssumeRoleCommandInput } from "@aws-sdk/client-sts";
import type { AssumedAwsCredentials, AwsSender, CloudWatchAws } from "../../packages/broker/src/connectors/native/cloudwatch.js";

export const OWN_ACCOUNT = "944937319445";
export const CUSTOMER_ACCOUNT = "123456789012";
export const CUSTOMER_ROLE = `arn:aws:iam::${CUSTOMER_ACCOUNT}:role/rovara-read`;
export const START_MS = Date.parse("2026-10-22T12:00:00.000Z");

export interface FakeAlarm { name: string; state: "ALARM" | "OK" | "INSUFFICIENT_DATA"; reason?: string; namespace?: string; metric?: string }
export interface FakeHistoryItem { alarm: string; type: string; summary: string; at: string }
export interface FakeSeries { label: string; values: Array<[string, number]> }

export interface FakeCloudWatchOptions {
  /** Each role Rovara may assume, and the one external id its trust policy requires. */
  roles?: Record<string, { externalId: string }>;
  ownAccountId?: string | undefined;
  alarms?: readonly FakeAlarm[];
  /** DescribeAlarms answers every alarm whatever prefix or state was asked, as a misbehaving service could. */
  leakAlarms?: boolean;
  history?: readonly FakeHistoryItem[];
  /** DescribeAlarmHistory answers every alarm's history whatever alarm name was asked. */
  leakHistory?: boolean;
  series?: readonly FakeSeries[];
  logGroups?: readonly string[];
  /** DescribeLogGroups answers every group whatever prefix was asked. */
  leakLogGroups?: boolean;
  /** The statuses GetQueryResults answers in turn; the last one repeats. */
  queryStatuses?: readonly string[];
  queryRows?: ReadonlyArray<ReadonlyArray<{ field: string; value: string }>>;
  /** A command (by class name) that fails with this error. */
  fail?: Record<string, Error>;
  /** Text put in the first alarm's reason (a test puts a session secret here to prove it is scrubbed). */
  reasonOverride?: (credentials: AssumedAwsCredentials) => string;
}

export interface AwsCall { service: "sts" | "monitoring" | "logs"; name: string; input: Record<string, unknown>; region: string; accessKeyId: string }

export const awsError = (name: string, message = `${name}: the vendor's own message, with details`): Error => Object.assign(new Error(message), { name });

export function fakeCloudWatchAws(options: FakeCloudWatchOptions = {}) {
  const calls: AwsCall[] = [];
  const assumed: AssumeRoleCommandInput[] = [];
  const issued: AssumedAwsCredentials[] = [];
  let clock = START_MS;
  let queryPolls = 0;
  const roles = options.roles ?? {};
  const alarms = options.alarms ?? [];

  const credentialsFor = (index: number): AssumedAwsCredentials => ({
    accessKeyId: `ASIAFAKEKEY${String(index).padStart(4, "0")}`,
    secretAccessKey: `fakeSecretAccessKey${String(index).padStart(4, "0")}ABCDEFGHIJ`,
    sessionToken: `FwoGZXIvYXdzFAKESESSIONTOKEN${String(index).padStart(4, "0")}0123456789`,
    expiration: new Date(clock + 900_000),
  });

  const handle = (service: AwsCall["service"], region: string, accessKeyId: string): AwsSender => ({
    async send(command: unknown) {
      const named = command as { constructor: { name: string }; input: Record<string, unknown> };
      const name = named.constructor.name;
      const input = named.input;
      calls.push({ service, name, input, region, accessKeyId });
      const failure = options.fail?.[name];
      if (failure !== undefined) throw failure;
      switch (name) {
        case "GetCallerIdentityCommand": return { Account: CUSTOMER_ACCOUNT, Arn: `arn:aws:sts::${CUSTOMER_ACCOUNT}:assumed-role/rovara-read/rovara-x`, UserId: "AROAFAKE:rovara-x" };
        case "DescribeAlarmsCommand": {
          const prefix = typeof input["AlarmNamePrefix"] === "string" ? input["AlarmNamePrefix"] : undefined;
          const state = input["StateValue"];
          const chosen = alarms.filter((alarm) => (options.leakAlarms === true || prefix === undefined || alarm.name.startsWith(prefix)) && (options.leakAlarms === true || state === undefined || alarm.state === state));
          const max = typeof input["MaxRecords"] === "number" ? input["MaxRecords"] : chosen.length;
          return {
            MetricAlarms: chosen.slice(0, max).map((alarm, index) => ({
              AlarmName: alarm.name, StateValue: alarm.state,
              StateReason: index === 0 && options.reasonOverride !== undefined ? options.reasonOverride(issued.find((entry) => entry.accessKeyId === accessKeyId)!) : alarm.reason ?? "Threshold Crossed: 1 datapoint was greater than the threshold",
              StateUpdatedTimestamp: new Date(START_MS - 3_600_000), Namespace: alarm.namespace ?? "AWS/Lambda", MetricName: alarm.metric ?? "Errors",
            })),
            CompositeAlarms: [],
          };
        }
        case "DescribeAlarmHistoryCommand": {
          const items = (options.history ?? []).filter((item) => options.leakHistory === true || item.alarm === input["AlarmName"]);
          return { AlarmHistoryItems: items.map((item) => ({ AlarmName: item.alarm, HistoryItemType: item.type, HistorySummary: item.summary, Timestamp: new Date(item.at) })) };
        }
        case "GetMetricDataCommand": {
          const queries = (input["MetricDataQueries"] as Array<{ Id: string }>) ?? [];
          return {
            MetricDataResults: queries.map((query, index) => {
              const series = options.series?.[index] ?? { label: `series-${String(index)}`, values: [["2026-10-22T11:00:00.000Z", 1], ["2026-10-22T11:05:00.000Z", 5], ["2026-10-22T11:10:00.000Z", 3]] };
              return { Id: query.Id, Label: series.label, StatusCode: "Complete", Timestamps: series.values.map(([at]) => new Date(at)), Values: series.values.map(([, value]) => value) };
            }),
          };
        }
        case "DescribeLogGroupsCommand": {
          const prefix = typeof input["logGroupNamePrefix"] === "string" ? input["logGroupNamePrefix"] : "";
          return { logGroups: (options.logGroups ?? []).filter((group) => options.leakLogGroups === true || group.startsWith(prefix)).map((logGroupName) => ({ logGroupName })) };
        }
        case "StartQueryCommand": return { queryId: "query-0001" };
        case "GetQueryResultsCommand": {
          const statuses = options.queryStatuses ?? ["Complete"];
          const status = statuses[Math.min(queryPolls, statuses.length - 1)]!;
          queryPolls += 1;
          return { status, results: status === "Complete" ? (options.queryRows ?? [[{ field: "@timestamp", value: "2026-10-22 11:59:00.000" }, { field: "@message", value: "ERROR timeout calling payments" }, { field: "@ptr", value: "ptr-1" }]]) : [], statistics: { recordsMatched: 1 } };
        }
        case "StopQueryCommand": return { success: true };
        default: throw new Error(`test setup: the fake AWS does not know ${name}`);
      }
    },
  });

  const aws: CloudWatchAws = {
    ownAccountId: "ownAccountId" in options ? options.ownAccountId : OWN_ACCOUNT,
    now: () => clock,
    async sleep(ms) { clock += ms; },
    async assumeRole(input) {
      assumed.push(input);
      const trust = input.RoleArn === undefined ? undefined : roles[input.RoleArn];
      // The role's trust policy requires its external id; no external id, or another one, is refused as STS does.
      if (trust === undefined || input.ExternalId !== trust.externalId) throw awsError("AccessDenied", `User is not authorized to perform: sts:AssumeRole on ${String(input.RoleArn)} (the vendor's own message)`);
      const credentials = credentialsFor(issued.length + 1);
      issued.push(credentials);
      return credentials;
    },
    clientsFor(credentials, region) {
      return { sts: handle("sts", region, credentials.accessKeyId), monitoring: handle("monitoring", region, credentials.accessKeyId), logs: handle("logs", region, credentials.accessKeyId) };
    },
  };
  return {
    aws, calls, assumed, issued,
    elapsedMs: () => clock - START_MS,
    names: () => calls.map((call) => call.name),
    callsOf: (name: string) => calls.filter((call) => call.name === name),
  };
}
