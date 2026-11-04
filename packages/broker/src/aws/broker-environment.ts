// The broker's environment, put back together (Plan 3 final review C1).
//
// Lambda holds all of a function's environment variables, keys and values together, to 4 KB, and the broker's passed it. So the
// control plane does not give the broker what the code can build or derive:
//  - the names CloudFormation generated come in one variable, AGENTX_NAMES (`code=value` pairs: decodeBrokerList; the earlier JSON object is still read), under two-letter codes (BROKER_NAMES in
//    @agentx/contracts), and a queue, a key, a state machine or a role arrives as its bare name or id;
//  - the health route's dead-letter queues are names too, and the broker lists them as `{ label: URL }` (HEALTH_DEAD_LETTER_QUEUES);
//  - the sign-in issuers arrive as the id of the pool or the API they are an address of, and the model proxy as its load balancer's name;
//  - the settings that are constrained parameters (flags, limits, the Slack team) come in one variable, AGENTX_SETTINGS (BROKER_SETTINGS), under two-letter codes;
//  - what an environment's name decides (the alarm and secret prefixes, the metrics namespace, the runtime catalog ids, the
//    connector secrets role, the broker's own role, the audit and schedule queues) is derived from AGENTX_ENV by the functions the infrastructure creates those with
//    (DERIVED_BROKER_VARIABLES in @agentx/contracts: ENV-ROOM, the one place a derived name is written).
// `hydrateBrokerEnvironment` runs once, before anything else in the broker reads its environment, and sets each of these under the
// variable the broker's code has always read, so no reader changes and none is missed. It builds URLs and ARNs from the region
// Lambda gives every function (AWS_REGION) and the account (AGENTX_ACCOUNT_ID).
//
// Nothing here calls AWS. A variable that is already set is never replaced, and an environment without AGENTX_NAMES or AGENTX_SETTINGS (the legacy
// install, which passes everything whole, and every test that sets the variables itself) is left as it is.
import {
  BROKER_NAMES,
  BROKER_NAMES_VARIABLE,
  BROKER_SETTINGS,
  BROKER_SETTINGS_VARIABLE,
  BROKER_SETTING_VALUE,
  DERIVED_BROKER_VARIABLES,
  MODEL_PROXY_INFERENCE_PORT,
  decodeBrokerList,
  environmentRolePath,
  teamRecordOpsDeadLetterName,
  type BrokerNameSpec,
  type BrokerSettingSpec,
} from "@agentx/contracts";

export type MutableEnvironment = Record<string, string | undefined>;

/** The partition a region belongs to. */
export function awsPartitionOf(region: string): string {
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("us-isob-")) return "aws-iso-b";
  if (region.startsWith("us-iso-")) return "aws-iso";
  return "aws";
}

interface Scope { partition: string; region: string; account: string }

const ACCOUNT = /^[0-9]{12}$/;

/** The region and the account, which build a URL or an ARN from a name; a name that needs them and cannot have them is an error. */
function requiredScope(env: MutableEnvironment, needed: string): Scope {
  const region = env.AWS_REGION;
  if (region === undefined || region === "") throw new Error(`AWS_REGION is required to build ${needed}`);
  const account = env.AGENTX_ACCOUNT_ID;
  if (account === undefined || !ACCOUNT.test(account)) throw new Error(`AGENTX_ACCOUNT_ID (12 digits) is required to build ${needed}`);
  return { partition: awsPartitionOf(region), region, account };
}

const sqsHost = ({ partition, region }: Scope): string => `sqs.${region}.amazonaws.com${partition === "aws-cn" ? ".cn" : ""}`;
const queueUrl = (scope: Scope, name: string): string => `https://${sqsHost(scope)}/${scope.account}/${name}`;

/**
 * Rollout safety (the 0.4.3 staging rollout: "AGENTX_NAMES has a name nobody sent: rt"). During a rollout code can briefly start with the other revision's environment, so a
 * code this code does not know is skipped, with one log line naming the codes (never their values), and not fatal. A value that is malformed is still fatal: only an unknown
 * code is tolerated. In the other direction (newer code, older environment) a missing name is never made up: its variable stays unset and its reader fails closed, unless
 * DERIVED_BROKER_VARIABLES derives it.
 */
function logUnknownCodes(variable: string, codes: string[]): void {
  if (codes.length === 0) return;
  console.log(JSON.stringify({ level: "warn", event: "broker_environment.unknown_codes", variable, codes: [...codes].sort(), detail: "ignored: the environment is from another revision" }));
}

const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";
/** What CloudFormation gives a resource for a name or an id: no slash, no space, nothing a URL or an ARN would read differently. */
const NAME = /^[A-Za-z0-9._-]{1,255}$/;

/** What the API Gateway and Cognito hosts of a partition end in, as CloudFormation gives them. */
const apiHost = ({ partition, region }: Scope): string => `execute-api.${region}.amazonaws.com${partition === "aws-cn" ? ".cn" : ""}`;

/** The host an internal load balancer's DNS name ends in, as ELB gives it. */
const elbHost = ({ partition, region }: Scope): string => `${region}.elb.amazonaws.com${partition === "aws-cn" ? ".cn" : ""}`;

function build(spec: BrokerNameSpec, value: string, env: MutableEnvironment): string {
  const needed = `${spec.variable} from ${BROKER_NAMES_VARIABLE}.${spec.code}`;
  switch (spec.kind) {
    case "name": return value;
    case "queueUrl":
    case "deadLetterQueue": return queueUrl(requiredScope(env, needed), value);
    // The pool's issuer, to the text the control plane has always passed: the stack's region, `.amazonaws.com` in every partition (cloud-identity.ts).
    case "cognitoIssuer": return `https://cognito-idp.${requiredScope(env, needed).region}.amazonaws.com/${value}`;
    // The events API's HTTP endpoint (Plan 5 Task 8): `<dns prefix>.appsync-api.<region>.amazonaws.com/event`; the value is the first label of the API's `Dns.Http` host, not the API's id.
    case "eventApiEndpoint": {
      const scope = requiredScope(env, needed);
      return `https://${value}.appsync-api.${scope.region}.amazonaws.com${scope.partition === "aws-cn" ? ".cn" : ""}/event`;
    }
    case "modelProxyUrl": return `http://${value}.${elbHost(requiredScope(env, needed))}:${MODEL_PROXY_INFERENCE_PORT}`;
    case "apiIssuer": return `https://${value}.${apiHost(requiredScope(env, needed))}/v1/auth`;
    case "kmsKeyArn": {
      const scope = requiredScope(env, needed);
      return `arn:${scope.partition}:kms:${scope.region}:${scope.account}:key/${value}`;
    }
    case "stateMachineArn": {
      const scope = requiredScope(env, needed);
      return `arn:${scope.partition}:states:${scope.region}:${scope.account}:stateMachine:${value}`;
    }
    case "lambdaFunctionArn": {
      const scope = requiredScope(env, needed);
      return `arn:${scope.partition}:lambda:${scope.region}:${scope.account}:function:${value}`;
    }
    case "roleArn": {
      const scope = requiredScope(env, needed);
      const name = env.AGENTX_ENV;
      if (!isSet(name)) throw new Error(`AGENTX_ENV is required to build ${needed}`);
      return `arn:${scope.partition}:iam::${scope.account}:role${environmentRolePath(name)}${value}`;
    }
  }
}

/** The names AGENTX_NAMES may hold, by code. */
const BY_CODE: ReadonlyMap<string, BrokerNameSpec> = new Map(Object.values(BROKER_NAMES).map((spec) => [spec.code, spec]));

/**
 * AGENTX_NAMES as the names under their variables. A list that is not exactly an object of known codes and plain names throws, so a broker
 * that cannot name what it needs does not start (it would fail on the first request instead, with less to go on).
 */
export function brokerNamesFromEnvironment(env: MutableEnvironment): Array<{ spec: BrokerNameSpec; value: string }> {
  const raw = env[BROKER_NAMES_VARIABLE];
  if (!isSet(raw)) return [];
  const fail = (why: string): never => { throw new Error(`${BROKER_NAMES_VARIABLE} ${why}`); };
  const decoded = decodeBrokerList(raw);
  if ("error" in decoded) return fail(decoded.error);
  const unknown: string[] = [];
  const known = decoded.entries.flatMap(([code, value]) => {
    const spec = BY_CODE.get(code);
    if (spec === undefined) { unknown.push(code); return []; }
    if (typeof value !== "string" || !NAME.test(value)) return fail(`has no valid name for ${code} (${spec.variable})`);
    return [{ spec, value }];
  });
  logUnknownCodes(BROKER_NAMES_VARIABLE, unknown);
  return known;
}

/**
 * What the environment's name decides, as the variables the broker reads them as: every entry of DERIVED_BROKER_VARIABLES (contracts/derived-names.ts, the functions CDK names
 * the resources with). The hosted cloud's entries are built only where AGENTX_CLOUD is set, the control plane's own condition for creating the resource.
 */
function derived(env: MutableEnvironment, name: string): Array<[string, () => string]> {
  return DERIVED_BROKER_VARIABLES.filter((entry) => entry.cloudOnly !== true || env.AGENTX_CLOUD === "true").map((entry): [string, () => string] => {
    switch (entry.kind) {
      case "text": return [entry.variable, () => entry.value(name)];
      case "queueUrl": return [entry.variable, () => queueUrl(requiredScope(env, entry.variable), entry.queueName(name))];
      case "roleArn": return [entry.variable, () => {
        const scope = requiredScope(env, entry.variable);
        return `arn:${scope.partition}:iam::${scope.account}:role${environmentRolePath(name)}${entry.roleName(name)}`;
      }];
      case "kmsAliasArn": return [entry.variable, () => {
        const scope = requiredScope(env, entry.variable);
        return `arn:${scope.partition}:kms:${scope.region}:${scope.account}:${entry.alias(name)}`;
      }];
    }
  });
}

/** The settings AGENTX_SETTINGS may hold, by code. */
const SETTING_BY_CODE: ReadonlyMap<string, BrokerSettingSpec> = new Map(Object.values(BROKER_SETTINGS).map((spec) => [spec.code, spec]));

/**
 * AGENTX_SETTINGS as the settings under their variables. A list that is not exactly an object of known codes and plain values throws, so a broker that cannot read its settings
 * does not start (a flag read as unset would turn a feature off without a word).
 */
export function brokerSettingsFromEnvironment(env: MutableEnvironment): Array<{ spec: BrokerSettingSpec; value: string }> {
  const raw = env[BROKER_SETTINGS_VARIABLE];
  if (!isSet(raw)) return [];
  const fail = (why: string): never => { throw new Error(`${BROKER_SETTINGS_VARIABLE} ${why}`); };
  const decoded = decodeBrokerList(raw);
  if ("error" in decoded) return fail(decoded.error);
  const unknown: string[] = [];
  const known = decoded.entries.flatMap(([code, value]) => {
    const spec = SETTING_BY_CODE.get(code);
    if (spec === undefined) { unknown.push(code); return []; }
    if (typeof value !== "string" || !BROKER_SETTING_VALUE.test(value)) return fail(`has no plain value for ${code} (${spec.variable})`);
    return [{ spec, value }];
  });
  logUnknownCodes(BROKER_SETTINGS_VARIABLE, unknown);
  return known;
}

/**
 * Sets, in `env`, what the control plane did not pass whole. Only where AGENTX_NAMES is present (a named environment's broker): the names
 * under their variables (the dead-letter queues as one JSON object of URLs by label), then what the environment's name decides. A variable
 * that is already set is not replaced.
 */
export function hydrateBrokerEnvironment(env: MutableEnvironment): void {
  // The settings first: they are plain values the rest does not need, and a bad list stops the broker before anything is built from it. A variable that is already set is kept
  // (an empty setting, an install that leaves the Slack team out, is set as empty, as the parameter's own value was).
  for (const { spec, value } of brokerSettingsFromEnvironment(env)) {
    if (!isSet(env[spec.variable])) env[spec.variable] = value;
  }
  if (!isSet(env[BROKER_NAMES_VARIABLE])) return;
  const queues = new Map<BrokerNameSpec, string>();
  for (const { spec, value } of brokerNamesFromEnvironment(env)) {
    if (spec.kind === "deadLetterQueue") queues.set(spec, build(spec, value, env));
    else if (!isSet(env[spec.variable])) env[spec.variable] = build(spec, value, env);
  }
  // The route lists the queues in the table's order, whatever order the names came in.
  const listed: Array<readonly [string, string]> = Object.values(BROKER_NAMES).flatMap((spec: BrokerNameSpec) => (queues.has(spec) ? [[spec.label ?? spec.code, queues.get(spec)!] as const] : []));
  const name = env.AGENTX_ENV;
  // The Team record's operations dead-letter queue has a fixed name (`teamRecordOpsDeadLetterName`), so it is derived, not passed (ENV-ROOM): listed last, as it always was, and only where the record is on.
  if (env.TEAM_RECORD_ENABLED === "1" && isSet(name)) listed.push(["team-record", queueUrl(requiredScope(env, "HEALTH_DEAD_LETTER_QUEUES team-record"), teamRecordOpsDeadLetterName(name))]);
  if (listed.length > 0 && !isSet(env.HEALTH_DEAD_LETTER_QUEUES)) env.HEALTH_DEAD_LETTER_QUEUES = JSON.stringify(Object.fromEntries(listed));
  if (!isSet(name)) return;
  for (const [variable, value] of derived(env, name)) {
    if (!isSet(env[variable])) env[variable] = value();
  }
}
