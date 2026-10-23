// The broker's environment, put back together (Plan 3 final review C1).
//
// Lambda holds all of a function's environment variables, keys and values together, to 4 KB, and the broker's passed it. So the
// control plane does not give the broker what the code can build or derive:
//  - the names CloudFormation generated come in one JSON variable, AGENTX_NAMES, under two-letter codes (BROKER_NAMES in
//    @agentx/contracts), and a queue, a key, a state machine or a role arrives as its bare name or id;
//  - the health route's dead-letter queues are names too, and the broker lists them as `{ label: URL }` (HEALTH_DEAD_LETTER_QUEUES);
//  - the sign-in issuers arrive as the id of the pool or the API they are an address of;
//  - what an environment's name decides (the alarm and secret prefixes, the metrics namespace, the runtime catalog ids, the
//    connector secrets role) is derived from AGENTX_ENV by the functions the infrastructure creates those with.
// `hydrateBrokerEnvironment` runs once, before anything else in the broker reads its environment, and sets each of these under the
// variable the broker's code has always read, so no reader changes and none is missed. It builds URLs and ARNs from the region
// Lambda gives every function (AWS_REGION) and the account (AGENTX_ACCOUNT_ID).
//
// Nothing here calls AWS. A variable that is already set is never replaced, and an environment without AGENTX_NAMES (the legacy
// install, which passes everything whole, and every test that sets the variables itself) is left as it is.
import {
  BROKER_NAMES,
  BROKER_NAMES_VARIABLE,
  connectorSecretsRoleName,
  environmentAlarmPrefix,
  environmentConnectorSecretPrefix,
  environmentE2eFeatureRuntimeCatalogId,
  environmentMetricsNamespace,
  environmentProjectSetupRuntimeCatalogId,
  environmentRolePath,
  environmentSettingsPrefix,
  type BrokerNameSpec,
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

const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";
/** What CloudFormation gives a resource for a name or an id: no slash, no space, nothing a URL or an ARN would read differently. */
const NAME = /^[A-Za-z0-9._-]{1,255}$/;

/** What the API Gateway and Cognito hosts of a partition end in, as CloudFormation gives them. */
const apiHost = ({ partition, region }: Scope): string => `execute-api.${region}.amazonaws.com${partition === "aws-cn" ? ".cn" : ""}`;

function build(spec: BrokerNameSpec, value: string, env: MutableEnvironment): string {
  const needed = `${spec.variable} from ${BROKER_NAMES_VARIABLE}.${spec.code}`;
  switch (spec.kind) {
    case "name": return value;
    case "queueUrl":
    case "deadLetterQueue": return queueUrl(requiredScope(env, needed), value);
    // The pool's issuer, to the text the control plane has always passed: the stack's region, `.amazonaws.com` in every partition (cloud-identity.ts).
    case "cognitoIssuer": return `https://cognito-idp.${requiredScope(env, needed).region}.amazonaws.com/${value}`;
    case "apiIssuer": return `https://${value}.${apiHost(requiredScope(env, needed))}/v1/auth`;
    case "kmsKeyArn": {
      const scope = requiredScope(env, needed);
      return `arn:${scope.partition}:kms:${scope.region}:${scope.account}:key/${value}`;
    }
    case "stateMachineArn": {
      const scope = requiredScope(env, needed);
      return `arn:${scope.partition}:states:${scope.region}:${scope.account}:stateMachine:${value}`;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail("is not an object of names");
  return Object.entries(parsed).map(([code, value]) => {
    const spec = BY_CODE.get(code);
    if (spec === undefined) return fail(`has a name nobody sent: ${code}`);
    if (typeof value !== "string" || !NAME.test(value)) return fail(`has no valid name for ${code} (${spec.variable})`);
    return { spec, value };
  });
}

/** What the environment's name decides, as the variables the broker reads them as. */
function derived(env: MutableEnvironment, name: string): Array<[string, () => string]> {
  return [
    ["CONNECTOR_SECRET_PREFIX", () => environmentConnectorSecretPrefix(name)],
    ["SWEBENCH_SETTINGS_PREFIX", () => environmentSettingsPrefix(name)],
    ["AGENTX_ALARM_PREFIX", () => environmentAlarmPrefix(name)],
    ["AGENTX_METRICS_NAMESPACE", () => environmentMetricsNamespace(name)],
    ["AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID", () => environmentProjectSetupRuntimeCatalogId(name)],
    ["AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID", () => environmentE2eFeatureRuntimeCatalogId(name)],
    // The one role the broker assumes for an org's connection secrets: the control plane names it for the environment and puts it under the environment's role path.
    ["CONNECTOR_SECRETS_ROLE_ARN", () => {
      const scope = requiredScope(env, "CONNECTOR_SECRETS_ROLE_ARN");
      return `arn:${scope.partition}:iam::${scope.account}:role${environmentRolePath(name)}${connectorSecretsRoleName(name)}`;
    }],
  ];
}

/**
 * Sets, in `env`, what the control plane did not pass whole. Only where AGENTX_NAMES is present (a named environment's broker): the names
 * under their variables (the dead-letter queues as one JSON object of URLs by label), then what the environment's name decides. A variable
 * that is already set is not replaced.
 */
export function hydrateBrokerEnvironment(env: MutableEnvironment): void {
  if (!isSet(env[BROKER_NAMES_VARIABLE])) return;
  const queues = new Map<BrokerNameSpec, string>();
  for (const { spec, value } of brokerNamesFromEnvironment(env)) {
    if (spec.kind === "deadLetterQueue") queues.set(spec, build(spec, value, env));
    else if (!isSet(env[spec.variable])) env[spec.variable] = build(spec, value, env);
  }
  // The route lists the queues in the table's order, whatever order the names came in.
  const listed = Object.values(BROKER_NAMES).flatMap((spec: BrokerNameSpec) => (queues.has(spec) ? [[spec.label ?? spec.code, queues.get(spec)!] as const] : []));
  if (listed.length > 0 && !isSet(env.HEALTH_DEAD_LETTER_QUEUES)) env.HEALTH_DEAD_LETTER_QUEUES = JSON.stringify(Object.fromEntries(listed));
  const name = env.AGENTX_ENV;
  if (!isSet(name)) return;
  for (const [variable, value] of derived(env, name)) {
    if (!isSet(env[variable])) env[variable] = value();
  }
}
